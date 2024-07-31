import { error, redirect } from '@sveltejs/kit';
import Stripe from 'stripe';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({
	params,
	url,
	locals: { safeGetSession, supabaseServiceRole, stripe },
}) => {
	const { session, user } = await safeGetSession();
	if (!session || !user) {
		const search = new URLSearchParams(url.search);
		search.set('next', url.pathname);
		throw redirect(303, `/register?${search.toString()}`);
	}

	const price = await stripe.prices.retrieve(params.priceID);

	const { data: results } = await supabaseServiceRole
		.from('stripe_customers')
		.select('stripe_customer_id')
		.eq('user_id', user.id);

	let customer: string;
	if (results && results.length > 0) {
		customer = results[0].stripe_customer_id;
	} else {
		const { id } = await stripe.customers.create({
			email: user.email,
			metadata: {
				user_id: user.id,
			},
		});

		customer = id;

		const { error: upsertError } = await supabaseServiceRole
			.from('stripe_customers')
			.upsert(
				{ user_id: user.id, stripe_customer_id: customer },
				{ onConflict: 'user_id' },
			);

		if (upsertError) {
			console.error(upsertError);
			throw error(500, 'Unknown Error: If issue persists please contact us.');
		}
	}

	const subscriptionsPromise = stripe.subscriptions.list({
		customer,
		limit: 100,
	});

	const [{ data: subscriptions }] = await Promise.all([
		subscriptionsPromise,
		// productsPromise,
	]);

	const currentSubscriptions = subscriptions.filter((sub) =>
		['active', 'trailing', 'past_due'].includes(sub.status),
	);

	// const activeProductId = currentSubscriptions.map(
	// 	(sub) => sub.items.data[0].price.product as string,
	// )[0]; // force string as we don't expand
	// const sortedProductIds = products.map((product) => product.id);

	// const comparison =
	// 	sortedProductIds.indexOf(activeProductId) -
	// 	sortedProductIds.indexOf(price.product as string);

	stripe.subscriptions.update(currentSubscriptions[0].id, {
		items: [
			{
				id: currentSubscriptions[0].items.data[0].id,
				price: price.id,
			},
		],
	});

	const lineItems: Stripe.Checkout.SessionCreateParams['line_items'] = [
		{
			...(price.custom_unit_amount
				? {
						price_data: {
							unit_amount: url.searchParams.has('customAmount')
								? parseInt(url.searchParams.get('customAmount') || '0', 10) *
									100
								: price.custom_unit_amount.preset || 0,
							currency: price.currency,
							product: price.product as string,
						},
					}
				: { price: price.id }),
			quantity: 1,
		},
	];

	let checkoutUrl;
	try {
		const checkoutSession = await stripe.checkout.sessions.create({
			line_items: lineItems,
			customer,
			mode: price.type === 'recurring' ? 'subscription' : 'payment',
			success_url: `${url.origin}/dashboard`,
			cancel_url: `${url.origin}/settings/billing`,
			// recurring prices have invoice creation enabled automatically
			...(price.type === 'recurring'
				? {}
				: {
						invoice_creation: {
							enabled: true,
						},
					}),
		});
		checkoutUrl = checkoutSession.url;
	} catch (e) {
		console.error(e);
		throw error(500, 'Unknown Error: If issue persists please contact us.');
	}

	throw redirect(303, checkoutUrl ?? '/pricing');
};
