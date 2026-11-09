# Settlement Engine (Architecture Docs v1)
- **IdempotencyGuard**: Uses Redis Lua atomic lock with `DEFAULT_TTL_MS = 30000` (30 seconds).
- **LedgerClient**: `getBalanceUnits(id)`, `postDebit(req)`, `refundDebit(txRef, units)`.
- **PromoEngine**: `releaseCoupon(voucherCode, buyerId)`.
- **AuditSink**: `recordEvent(category, orderId, meta)`.
