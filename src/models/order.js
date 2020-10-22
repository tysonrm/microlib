'use strict'

import {
  requirePropertiesMixin,
  freezePropertiesMixin,
  validatePropertiesMixin,
  updatePropertiesMixin,
  processUpdate,
  checkFormat,
  PREVMODEL,
} from './mixins'

import { InterfaceAdapter } from '../lib/adapter';

const MAXORDER = 99999.99;
const orderItems = 'orderItems';
const customerInfo = 'customerInfo';
const shippingAddress = 'shippingAddress';
const billingAddress = 'billingAddress';
const proofOfDelivery = 'proofOfDelivery';
const creditCardNumber = 'creditCardNumber';
const paymentAuthorization = 'paymentAuthorization';
const customerId = 'customerId';
const orderStatus = 'orderStatus';
const orderTotal = 'orderTotal';
const cancelReason = 'cancelReason';
const orderNo = 'orderNo';
const OrderStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  SHIPPING: 'SHIPPING',
  COMPLETE: 'COMPLETE',
  CANCELED: 'CANCELED'
}

const checkItems = function (items) {
  if (!items) {
    throw new Error('order contains no items');
  }
  const _items = Array.isArray(items)
    ? items
    : [items];

  if (_items.length > 0
    && _items.every(i => i['itemId']
      && typeof i['price'] === 'number'
    )) {
    return _items;
  }
  throw new Error('order items invalid');
}

const calcTotal = function (items) {
  const _items = checkItems(items);
  return _items.reduce((total, item) => {
    return total += item.price
  }, 0);
}

/**
 * No changes to `propKey` once order is approved
 * @param {*} o - the order
 * @param {*} propKey 
 * @returns {string | null} the key or `null`
 */
const freezeOnApproval = (propKey) => (o) => {
  return o[PREVMODEL].orderStatus !== OrderStatus.PENDING
    ? propKey
    : null;
}

/**
 * No changes to `propKey` once order is complete or canceled
 * @param {*} o - the order
 * @param {*} propKey 
 * @returns {string | null} the key or `null`
 */
const freezeOnCompletion = (propKey) => (o) => {
  return [
    OrderStatus.COMPLETE,
    OrderStatus.CANCELED
  ].includes(o[PREVMODEL].orderStatus)
    ? propKey
    : null;
}

/**
 * Value required to complete order
 * @param {*} o 
 * @param {*} propKey
 * @returns {string | void} the key or `void`
 */
const requiredForCompletion = (propKey) => (o) => {
  if (!o.orderStatus) {
    return;
  }
  return o.orderStatus === OrderStatus.COMPLETE
    ? propKey
    : void 0;
}

const invalidStatusChange = (from, to) => (o, propVal) => {
  return propVal === to && o[PREVMODEL].orderStatus === from;
}

const invalidStatusChanges = [
  // Can't change back to pending once approved
  invalidStatusChange(OrderStatus.APPROVED, OrderStatus.PENDING),
  // Can't change back to pending once shipped
  invalidStatusChange(OrderStatus.SHIPPING, OrderStatus.PENDING),
  // Can't change back to approved once shipped
  invalidStatusChange(OrderStatus.SHIPPING, OrderStatus.APPROVED),
  // Can't change directly to shipping from pending
  invalidStatusChange(OrderStatus.PENDING, OrderStatus.SHIPPING),
  // Can't change directly to complete from pending
  invalidStatusChange(OrderStatus.PENDING, OrderStatus.COMPLETE)
];

/**
 * Check that status changes are valid
 */
export const statusChangeValid = (o, propVal) => {
  if (!o[PREVMODEL]?.orderStatus) {
    return true;
  }
  if (invalidStatusChanges.some(i => i(o, propVal))) {
    throw new Error('invalid status change');
  }
  return true;
}

/** 
 * Don't delete orders before they're complete.
 */
function readyToDelete(model) {
  if (![
    OrderStatus.COMPLETE,
    OrderStatus.CANCELED
  ].includes(model.orderStatus)) {
    throw new Error('order status incomplete');
  }
  return model;
}

async function orderShipped({ message, consumer }) {
  const order = this;
  console.log(message);
  order.trackShipment();
  order.orderStatus = OrderStatus.SHIPPING;
  await handleStatusChange(order);
  consumer.unsubscribe(); // unsubscribe
}

async function shipOrder(order) {
  try {
    await order.completePayment();
    await order.shipOrder();
    try { // listen for shipping events
      await order.consumeEvents(
        'shipping', orderShipped
      ).then(consumer => {
        console.log(consumer.getSubscriptions());
      });
    } catch (e) {
      // consumeEvents is on
      // the host, not here
      console.error(e.message);
    }
  } catch (error) {
    throw new Error(error);
  }
}

async function trackShipment(order) {
  await order.trackShipment();
}

async function refundPayment(order) {
  await order.refundPayment();
}

async function verifyDelivery(order) {
  await order.verifyDelivery();
}

const OrderActions = {
  [OrderStatus.PENDING]: () => void 0,
  [OrderStatus.APPROVED]: shipOrder,
  [OrderStatus.SHIPPING]: trackShipment,
  [OrderStatus.CANCELED]: refundPayment,
  [OrderStatus.COMPLETE]: verifyDelivery
}

export async function handleStatusChange(order) {
  await OrderActions[order.orderStatus](order);
}

/**
 * @type {import('./index').ModelSpecification}
 */
const Order = {
  modelName: 'order',
  endpoint: 'orders',
  factory: function ({
    validateAddress,
    authorizePayment,
    completePayment,
    refundPayment,
    shipOrder,
    trackShipment,
    verifyDelivery,
    CustomerService,
    consumeEvents,
    uuid,
  }) {
    return async function createOrder({
      customerInfo,
      orderItems,
      shippingAddress,
      billingAddress,
      creditCardNumber,
      signatureRequired = false
    }) {
      let adapter;
      checkItems(orderItems);
      checkFormat(creditCardNumber, 'creditCard');
      const custSrv = new CustomerService();
      const custId = await custSrv.findCustomer(customerInfo);
      if (!custId) {
        throw new Error('no customer found: %s', customerInfo);
      }
      const shipAddr = await validateAddress(shippingAddress);
      const payAuth = await authorizePayment({
        customerInfo,
        creditCardNumber,
        billingAddress,
        totalCharge: calcTotal(orderItems)
      });
      return Object.freeze({
        loadAdapters(adapter) {
          adapter.add(completePayment, function (fn) {
            return fn(this.decrypt().creditCardNumber);
          });
          adapter.add(refundPayment, function (fn) {
            return fn(this.decrypt().creditCardNumber);
          });
          adapter.add(shipOrder, function (fn) {
            return fn({
              lineItem: this.orderItems.map(i => ({ id: i.itemId })),
              shipAddr: this.decrypt().shippingAddress,
            });
          });
          adapter.add(trackShipment, function (fn) {
            return fn(this.decrypt().shippingAddress);
          });
          adapter.add(verifyDelivery, function (fn) {
            return fn(this.signatureRequired);
          });
          return adapter;
        },
        callAdapter(iface) {
          if (!adapter) {
            const iface = InterfaceAdapter(this);
            adapter = this.loadAdapters(iface);
          }
          return adapter.invoke(iface);
        },
        completePayment() {
          return this.callAdapter(completePayment);
        },
        refundPayment() {
          return this.callAdapter(refundPayment);
        },
        shipOrder() {
          return this.callAdapter(shipOrder);
        },
        trackShipment() {
          return this.callAdapter(trackShipment);
        },
        verifyDelivery() {
          return this.callAdapter(verifyDelivery);
        },
        consumeEvents(topic, handler) {
          const self = this;
          try {
            return consumeEvents(topic, this.orderNo,
              function (eventData) {
                handler.call(self, eventData);
              }
            );
          } catch (e) {
            // consumeEvents is on the host
            console.error(e.message);
          }
        },
        customerInfo,
        orderItems,
        creditCardNumber,
        billingAddress,
        signatureRequired,
        shippingAddress: shipAddr,
        [customerId]: custId,
        [paymentAuthorization]: payAuth,
        [orderTotal]: calcTotal(orderItems),
        [orderStatus]: OrderStatus.PENDING,
        [proofOfDelivery]: null,
        [cancelReason]: null,
        [orderNo]: uuid(),
      });
    }
  },
  mixins: [
    requirePropertiesMixin(
      customerInfo,
      customerId,
      orderItems,
      creditCardNumber,
      shippingAddress,
      billingAddress,
      requiredForCompletion(proofOfDelivery)
    ),
    freezePropertiesMixin(
      customerInfo,
      freezeOnApproval(orderItems),
      freezeOnApproval(creditCardNumber),
      freezeOnApproval(shippingAddress),
      freezeOnApproval(billingAddress),
      freezeOnCompletion(orderStatus),
    ),
    updatePropertiesMixin([
      {
        // Recalc total
        propKey: orderItems,
        update: (o, propVal) => ({
          orderTotal: calcTotal(propVal)
        }),
      }
    ]),
    validatePropertiesMixin([
      {
        propKey: orderStatus,
        values: Object.values(OrderStatus),
        isValid: statusChangeValid,
      },
      {
        propKey: orderTotal,
        maxnum: MAXORDER
      }
    ]),
  ],
  onUpdate: processUpdate,
  onDelete: model => readyToDelete(model),
  eventHandlers: [
    async ({ model, changes }) => {
      if (changes?.orderStatus) {
        await handleStatusChange(model);
      }
    }
  ]
}

export default Order