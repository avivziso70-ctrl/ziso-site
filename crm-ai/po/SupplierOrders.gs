/**
 * SupplierOrders.gs — add to the "Ziso Priority Bridge" Apps Script project (Aviv's Gmail, next to CrmPush.gs).
 * Sends supplier orders created in the CRM (מחירון ספקים > הזמנה לספק) and listens for the supplier's answer.
 * Every 5 minutes:
 *   1. outbox: crm-po returns orders a staff member confirmed in the CRM; each one is sent from this Gmail
 *      to the supplier (Dior: Irena) with Eilat + Shir in cc, and the Gmail thread is reported back (yellow in the CRM).
 *   2. watch: new messages on those threads are posted to crm-po, which reads them (green = confirmed,
 *      orange = question / missing item). Every supplier answer is forwarded to Eilat + Shir if they were not on it.
 * Uses the same script property as CrmPush.gs (CRM_IMPORT_KEY). Without it: no-op. Priority is never touched.
 * Install: paste this file, then run setupSupplierOrders() once from the editor (creates the 5-minute trigger).
 */
var CRM_PO_URL = 'https://ppnjosyraosrdephsksu.supabase.co/functions/v1/crm-po';
var PO_TEAM = ['eilatziso50@gmail.com', 'shirziso1605@gmail.com'];

function supplierOrders() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    if (!PropertiesService.getScriptProperties().getProperty('CRM_IMPORT_KEY')) return;
    try { poSendOutbox_(); } catch (e) { Logger.log('po outbox: ' + e); }
    try { poWatchReplies_(); } catch (e) { Logger.log('po watch: ' + e); }
  } finally { lock.releaseLock(); }
}

function poCall_(body) {
  var key = PropertiesService.getScriptProperties().getProperty('CRM_IMPORT_KEY');
  var res = UrlFetchApp.fetch(CRM_PO_URL, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
    headers: { 'x-import-key': key }, muteHttpExceptions: true
  });
  var j = {};
  try { j = JSON.parse(res.getContentText()); } catch (e) { }
  if (res.getResponseCode() !== 200) throw new Error('crm-po ' + body.action + ' ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  return j;
}

function poSendOutbox_() {
  var r = poCall_({ action: 'outbox' });
  (r.orders || []).forEach(function (o) {
    var msg;
    try {
      var draft = GmailApp.createDraft(o.to, o.subject, o.text, { htmlBody: o.html, cc: (o.cc || []).join(','), name: 'זיסו קרמיקה' });
      msg = draft.send();
    } catch (e) {
      poCall_({ action: 'send_failed', id: o.id, error: String(e).slice(0, 250) });
      return;
    }
    // sent: report the thread. If this report fails the CRM marks the order "check Gmail" after 20 min and never resends.
    poCall_({ action: 'sent', id: o.id, thread_id: msg.getThread().getId(), msg_id: msg.getId() });
  });
}

function poWatchReplies_() {
  var r = poCall_({ action: 'watch' });
  (r.orders || []).forEach(function (o) {
    var thread;
    try { thread = GmailApp.getThreadById(o.thread_id); } catch (e) { thread = null; }
    if (!thread) return;
    var seen = {};
    (o.seen || []).forEach(function (id) { seen[id] = true; });
    thread.getMessages().forEach(function (m) {
      if (seen[m.getId()] || m.isDraft()) return;
      var res = poCall_({ action: 'reply', id: o.id, msg_id: m.getId(), from: m.getFrom(), date: m.getDate().toISOString(), text: m.getPlainBody().slice(0, 8000) });
      if (res.forward) {
        var on = (m.getTo() + ',' + m.getCc()).toLowerCase();
        var missing = PO_TEAM.filter(function (a) { return on.indexOf(a) === -1; });
        if (missing.length) m.forward(missing.join(','), { name: 'זיסו קרמיקה' });
      }
    });
  });
}

function setupSupplierOrders() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'supplierOrders') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('supplierOrders').timeBased().everyMinutes(5).create();
  supplierOrders();
  Logger.log('supplier orders: trigger every 5 minutes is on');
}
