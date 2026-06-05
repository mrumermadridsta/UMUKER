const crypto = require('crypto');
const axios = require('axios');

class Telebirr {
  constructor(config = {}) {
    this.appId = config.appId || process.env.TELEBIRR_APP_ID;
    this.merchantId = config.merchantId || process.env.TELEBIRR_MERCHANT_ID;
    this.baseUrl = config.baseUrl || 'https://developerportal.ethiotelecom.et:9443';
    this.privateKey = config.privateKey;
    this.publicKey = config.publicKey;
    this.sandbox = config.sandbox !== false;
    if (!this.sandbox && (!this.privateKey || !this.publicKey)) {
      console.warn('⚠️ Telebirr: Missing private/public key, webhook verification will be disabled');
    }
  }

  sign(payload) {
    if (!this.privateKey) return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(JSON.stringify(payload));
    sign.end();
    return sign.sign(this.privateKey, 'base64');
  }

  async createOrder(params, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const result = await this._createOrderOnce(params);
        if (result.success) return result;
        if (i === retries-1) return result;
        await new Promise(r => setTimeout(r, 1000 * (i+1)));
      } catch(e) {
        if (i === retries-1) throw e;
      }
    }
  }

  async _createOrderOnce({ orderId, amount, subject, phone, returnUrl, notifyUrl }) {
    const payload = {
      appId: this.appId,
      merchantId: this.merchantId,
      nonceStr: crypto.randomBytes(16).toString('hex'),
      timestamp: Date.now(),
      orderId,
      totalAmount: amount.toString(),
      subject: subject || 'Bingo Top-up',
      phone,
      timeoutExpress: '30m',
      returnUrl: returnUrl || 'https://your-domain.com/wallet',
      notifyUrl: notifyUrl || 'https://your-domain.com/api/payment/telebirr/webhook'
    };
    payload.sign = this.sign(payload);
    if (this.sandbox) {
      console.log('[Telebirr SANDBOX] order:', orderId, amount);
      return { success: true, sandbox: true, orderId, checkoutUrl: `telebirr://payment?orderId=${orderId}` };
    }
    const res = await axios.post(`${this.baseUrl}/payment/v1/merchant/web/h5create`, payload, { timeout: 15000 });
    return { success: res.data.code === '0', orderId, checkoutUrl: res.data.data?.checkoutUrl, rawResponse: res.data };
  }

  async queryOrder(orderId) {
    const payload = { appId: this.appId, merchantId: this.merchantId, orderId, timestamp: Date.now(), nonceStr: crypto.randomBytes(16).toString('hex') };
    payload.sign = this.sign(payload);
    if (this.sandbox) return { success: true, status: 'PENDING' };
    const res = await axios.post(`${this.baseUrl}/payment/v1/merchant/query`, payload, { timeout: 10000 });
    return { success: res.data.code === '0', status: res.data.data?.orderStatus };
  }

  verifyWebhook(body, signature) {
    if (this.sandbox) return true;
    if (!this.publicKey) return true; // only for dev
    try {
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(JSON.stringify(body));
      verifier.end();
      return verifier.verify(this.publicKey, signature, 'base64');
    } catch(e) { return false; }
  }
}

module.exports = Telebirr;
