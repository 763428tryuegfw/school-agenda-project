// Durable Object com SQLite: guarda usuários, sessões e dados. Todas as chamadas vêm do Worker (RPC);
// o navegador nunca fala com este objeto diretamente. A lógica de verdade está em store.js (testada em Node).
import { DurableObject } from 'cloudflare:workers';
import { Store } from './store.js';

export class AppDB extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.s = new Store(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
    ctx.blockConcurrencyWhile(async () => { this.s.migrate(); });
  }
  getUserByEmail(a) { return this.s.getUserByEmail(a); }
  getUserById(a) { return this.s.getUserById(a); }
  createUser(a) { return this.s.createUser(a); }
  setPassword(a, b, c) { return this.s.setPassword(a, b, c); }
  createSession(a) { return this.s.createSession(a); }
  getSession(a, b) { return this.s.getSession(a, b); }
  deleteSession(a) { return this.s.deleteSession(a); }
  deleteUserSessions(a, b) { return this.s.deleteUserSessions(a, b); }
  listSessions(a, b) { return this.s.listSessions(a, b); }
  knownIp(a, b) { return this.s.knownIp(a, b); }
  rateHit(a, b, c, d) { return this.s.rateHit(a, b, c, d); }
  rateCheck(a, b, c, d) { return this.s.rateCheck(a, b, c, d); }
  rateFail(a, b, c, d) { return this.s.rateFail(a, b, c, d); }
  rateReset(a) { return this.s.rateReset(a); }
  rateRefund(a) { return this.s.rateRefund(a); }
  audit(a, b) { return this.s.audit(a, b); }
  purge(a) { return this.s.purge(a); }
  useRecoveryCode(a, b, c) { return this.s.useRecoveryCode(a, b, c); }
  replaceRecoveryCodes(a, b) { return this.s.replaceRecoveryCodes(a, b); }
  recoveryCodesLeft(a) { return this.s.recoveryCodesLeft(a); }
  createResetToken(a, b, c) { return this.s.createResetToken(a, b, c); }
  peekResetToken(a, b) { return this.s.peekResetToken(a, b); }
  consumeResetToken(a, b) { return this.s.consumeResetToken(a, b); }
  setTotpPending(a, b) { return this.s.setTotpPending(a, b); }
  enableTotp(a) { return this.s.enableTotp(a); }
  disableTotp(a) { return this.s.disableTotp(a); }
  totpMarkUsed(a, b) { return this.s.totpMarkUsed(a, b); }
  getState(a) { return this.s.getState(a); }
  applySync(a, b, c) { return this.s.applySync(a, b, c); }
  setNotifPrefs(a, b) { return this.s.setNotifPrefs(a, b); }
  addPushSub(a, b, c) { return this.s.addPushSub(a, b, c); }
  listPushSubs(a) { return this.s.listPushSubs(a); }
  removePushSub(a, b) { return this.s.removePushSub(a, b); }
  countPushSubs(a) { return this.s.countPushSubs(a); }
  deletePushSubById(a) { return this.s.deletePushSubById(a); }
  bumpPushFail(a) { return this.s.bumpPushFail(a); }
  resetPushFail(a) { return this.s.resetPushFail(a); }
  dueDigests(a, b) { return this.s.dueDigests(a, b); }
  markDigestSent(a, b) { return this.s.markDigestSent(a, b); }
  addFile(a, b, c, d, e) { return this.s.addFile(a, b, c, d, e); }
  listFiles(a) { return this.s.listFiles(a); }
  getFile(a, b) { return this.s.getFile(a, b); }
  readFileRange(a, b, c, d) { return this.s.readFileRange(a, b, c, d); }
  deleteFile(a, b) { return this.s.deleteFile(a, b); }
  exportUser(a) { return this.s.exportUser(a); }
  deleteUser(a) { return this.s.deleteUser(a); }
}
