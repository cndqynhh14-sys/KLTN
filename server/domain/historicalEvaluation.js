'use strict';

const HISTORICAL_KIND = 'HISTORICAL';
const NATIVE_KIND = 'NATIVE';

function sourceKind(ticket = {}) {
  return String(ticket.source_kind || NATIVE_KIND).trim().toUpperCase();
}

function isHistoricalTicket(ticket = {}) {
  return sourceKind(ticket) === HISTORICAL_KIND;
}

function historicalReadonlyError() {
  return Object.assign(new Error('historical_ticket_readonly'), {
    status: 409,
    code: 'historical_ticket_readonly',
    payload: { error: 'historical_ticket_readonly' },
  });
}

function assertTicketMutable(ticket) {
  if (isHistoricalTicket(ticket)) throw historicalReadonlyError();
  return ticket;
}

module.exports = {
  HISTORICAL_KIND,
  NATIVE_KIND,
  assertTicketMutable,
  historicalReadonlyError,
  isHistoricalTicket,
  sourceKind,
};
