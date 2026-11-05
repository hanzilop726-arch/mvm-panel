const crypto = require('crypto');
const { collections, getNextId } = require('../lib/db');

function amountValue(amount) {
  const value = Number(amount);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function getBalance(userId) {
  const user = await collections.users.findOne({ id: Number(userId) }, { projection: { bolts: 1 } });
  return Math.max(0, Number(user?.bolts) || 0);
}

async function credit(userId, amount, { source, reference = crypto.randomUUID(), actorId = null, details = {} }) {
  const value = amountValue(amount);
  if (!value) throw new Error('Bolt amount must be a positive whole number.');
  const row = {
    id: await getNextId('bolt_transactions'),
    user_id: Number(userId),
    amount: value,
    source: String(source || 'adjustment'),
    reference: String(reference),
    actor_id: actorId == null ? null : Number(actorId),
    details,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  try {
    await collections.bolt_transactions.insertOne(row);
  } catch (error) {
    if (error.code === 11000) {
      const existing = await collections.bolt_transactions.findOne({ reference: row.reference });
      if (!existing) throw error;
      if (existing.status === 'applied') return { credited: false, balance: await getBalance(userId) };
    } else {
      throw error;
    }
  }
  const updated = await collections.users.updateOne(
    { id: Number(userId), bolt_transaction_refs: { $ne: row.reference } },
    { $inc: { bolts: value }, $addToSet: { bolt_transaction_refs: row.reference } }
  );
  if (updated.matchedCount !== 1) {
    const alreadyApplied = await collections.users.findOne({ id: Number(userId), bolt_transaction_refs: row.reference });
    if (!alreadyApplied) {
      await collections.bolt_transactions.deleteOne({ reference: row.reference });
      throw new Error('Bolt wallet owner was not found.');
    }
  }
  await collections.bolt_transactions.updateOne({ reference: row.reference }, { $set: { status: 'applied' } });
  return { credited: updated.matchedCount === 1, balance: await getBalance(userId) };
}

async function spend(userId, amount, { source, reference = crypto.randomUUID(), details = {} }) {
  const value = amountValue(amount);
  if (!value) throw new Error('Bolt cost must be a positive whole number.');
  const row = {
    id: await getNextId('bolt_transactions'),
    user_id: Number(userId),
    amount: -value,
    source: String(source || 'purchase'),
    reference: String(reference),
    actor_id: null,
    details,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  try {
    await collections.bolt_transactions.insertOne(row);
  } catch (error) {
    if (error.code !== 11000) throw error;
    const existing = await collections.bolt_transactions.findOne({ reference: row.reference });
    if (!existing) throw error;
    if (existing.status === 'applied') return { spent: true, balance: await getBalance(userId) };
  }
  const updated = await collections.users.updateOne(
    { id: Number(userId), bolts: { $gte: value }, bolt_transaction_refs: { $ne: row.reference } },
    { $inc: { bolts: -value }, $addToSet: { bolt_transaction_refs: row.reference } }
  );
  if (updated.matchedCount !== 1) {
    const alreadyApplied = await collections.users.findOne({ id: Number(userId), bolt_transaction_refs: row.reference });
    if (!alreadyApplied) {
      await collections.bolt_transactions.deleteOne({ reference: row.reference });
      return { spent: false, balance: await getBalance(userId) };
    }
  }
  await collections.bolt_transactions.updateOne({ reference: row.reference }, { $set: { status: 'applied' } });
  return { spent: true, balance: await getBalance(userId) };
}

module.exports = { getBalance, credit, spend };