const { sequelize, Product, Order, OrderItem, Address } = require('../models');
const paymentService = require('../services/paymentService');
const shippingService = require('../services/shippingService');
const couponService = require('../services/couponService');
const { ensureFields } = require('../utils/validation');

async function resolveItems(rawItems) {
  if (!Array.isArray(rawItems) || !rawItems.length) {
    throw new Error('Itens inválidos.');
  }
  const items = [];
  for (const item of rawItems) {
    const qty = Number(item.qty || item.quantity || 1);
    if (!qty || qty <= 0) continue;
    let product = null;
    if (item.productId) {
      product = await Product.findByPk(item.productId);
    } else if (item.id) {
      const maybeId = Number(item.id);
      if (!Number.isNaN(maybeId) && Number.isFinite(maybeId)) {
        product = await Product.findByPk(maybeId);
      }
      if (!product) {
        product = await Product.findOne({ where: { sku: item.id } });
      }
    } else if (item.sku) {
      product = await Product.findOne({ where: { sku: item.sku } });
    }
    if (!product || !product.active) {
      throw new Error(`Produto não encontrado: ${item.sku || item.productId || item.id}`);
    }
    if (product.stockManaged && product.stockQuantity < qty) {
      throw new Error(`Estoque insuficiente para ${product.name}`);
    }
    items.push({
      product,
      qty,
      unit_price_cents: Number(item.price_cents ?? product.priceCents),
    });
  }
  if (!items.length) {
    throw new Error('Itens inválidos.');
  }
  return items;
}

async function quote(req, res) {
  try {
    let payload = req.body || {};
    if (!payload.items || !payload.destination) {
      const sku = String((req.query && (req.query.sku || req.query.id || req.query.productId)) || 'STACK-DUPLO');
      const qty = Number((req.query && req.query.qty) || 1);
      const cep = String((req.query && (req.query.cep || req.query.postal_code)) || '').replace(/\D/g, '').slice(0, 8);
      if (!cep) {
        return res.status(400).json({ error: 'Dados incompletos.' });
      }
      payload = { items: [{ sku, qty }], destination: { cep } };
    }
    const items = await resolveItems(payload.items);
    const destinationCep = (payload.destination.cep || payload.destination.postal_code || '').replace(/\D/g, '');
    const quoteResult = await shippingService.quote({
      destinationCep,
      items: items.map((item) => ({
        productId: item.product.id,
        qty: item.qty,
        price_cents: item.unit_price_cents,
      })),
    });
    return res.json(quoteResult);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
}

async function createOrder(req, res) {
  const transaction = await sequelize.transaction();
  try {
    const required = ensureFields(req.body, ['items', 'address_id', 'shipping']);
    if (required.length) {
      await transaction.rollback();
      return res.status(400).json({ error: 'Dados incompletos.' });
    }
    const items = await resolveItems(req.body.items);
    const address = await Address.findOne({ where: { id: req.body.address_id, userId: req.user.id } });
    if (!address) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Endereço inválido.' });
    }
    const subtotalCents = items.reduce((acc, item) => acc + item.unit_price_cents * item.qty, 0);

    let discountCents = 0;
    let coupon = null;
    if (req.body.coupon_code) {
      coupon = await couponService.findActiveCoupon(req.body.coupon_code);
      discountCents = couponService.computeDiscount(coupon, subtotalCents);
    }

    const shippingSelection = req.body.shipping || {};
    const shippingCents = Number(shippingSelection.price_cents || shippingSelection.cost_cents || 0);
    const totalCents = Math.max(0, subtotalCents + shippingCents - discountCents);

    const order = await Order.create(
      {
        userId: req.user.id,
        addressId: address.id,
        subtotalCents,
        shippingCents,
        discountCents,
        totalCents,
        shippingCarrier: shippingSelection.carrier || null,
        shippingService: shippingSelection.name || shippingSelection.service || null,
        shippingEstimateDays: shippingSelection.delivery_time_days || null,
      },
      { transaction },
    );

    for (const item of items) {
      await OrderItem.create(
        {
          orderId: order.id,
          productId: item.product.id,
          title: item.product.name,
          sku: item.product.sku,
          quantity: item.qty,
          unitPriceCents: item.unit_price_cents,
          weightGrams: item.product.weightGrams,
        },
        { transaction },
      );
      if (item.product.stockManaged) {
        await item.product.decrement('stockQuantity', { by: item.qty, transaction });
      }
    }

    const mpItems = items.map((item) => ({
      title: item.product.name,
      quantity: item.qty,
      currency_id: 'BRL',
      unit_price: item.unit_price_cents / 100,
    }));
    if (shippingCents > 0) {
      mpItems.push({
        title: shippingSelection.name ? `Frete - ${shippingSelection.name}` : 'Frete',
        quantity: 1,
        currency_id: 'BRL',
        unit_price: shippingCents / 100,
      });
    }
    if (discountCents > 0 && mpItems.length) {
      let remainingDiscount = discountCents;
      mpItems.forEach((mpItem) => {
        if (remainingDiscount <= 0) return;
        const itemTotalCents = Math.round(mpItem.unit_price * 100 * mpItem.quantity);
        if (itemTotalCents <= 0) return;
        const deduction = Math.min(itemTotalCents, remainingDiscount);
        const newTotalCents = itemTotalCents - deduction;
        mpItem.unit_price = Math.max(0, Math.round(newTotalCents / mpItem.quantity) / 100);
        remainingDiscount -= deduction;
      });
    }

    const preference = await paymentService.createPreference({
      items: mpItems,
      payer: {
        email: req.user.email,
        name: req.user.name,
        cpf: req.user.cpf,
      },
    });

    await order.update(
      {
        mercadoPagoPreferenceId: preference.preferenceId,
      },
      { transaction },
    );

    await transaction.commit();
    return res.json({
      orderId: order.id,
      preference_id: preference.preferenceId,
      init_point: preference.initPoint,
    });
  } catch (error) {
    await transaction.rollback();
    return res.status(400).json({ error: error.message || 'Falha ao criar pedido.' });
  }
}

module.exports = {
  quote,
  createOrder,
};

