const crypto = require('crypto');
const axios = require('axios');

class CBEBirr {
  constructor(config = {}) {
    this.merchantCode = config.merchantCode || process.env.CBE_MERCHANT_CODE;
    this.apiKey = config.apiKey || process.env.CBE_API_KEY;
    this.baseUrl = config.baseUrl || process.env.CBE_BASE_URL || 'https://api.cbe.com.et';
    this.privateKey = config.privateKey;
    this.publicKey = config.publicKey;
    this.sandbox = config.sandbox !== false;

    if (!this.sandbox && (!this.privateKey || !this.publicKey)) {
      console.error('❌ CBE: ለምርት የግል እና የህዝብ ቁልፎች ያስፈልጋሉ');
    }
  }

  sign(payload) {
    if (!this.privateKey) {
      return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    }
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(JSON.stringify(payload));
    sign.end();
    return sign.sign(this.privateKey, 'base64');
  }

  async createOrder({ orderId, amount, subject, phone, returnUrl, notifyUrl }) {
    const payload = {
      merchantCode: this.merchantCode,
      orderId,
      amount: amount.toFixed(2),
      currency: 'ETB',
      subject: subject || 'Bingo Top-up',
      customerPhone: phone,
      returnUrl: returnUrl || 'https://your-domain.com/wallet',
      notifyUrl: notifyUrl || 'https://your-domain.com/api/payment/cbe/webhook',
      timestamp: Date.now(),
      nonce: crypto.randomBytes(16).toString('hex')
    };
    payload.signature = this.sign(payload);

    try {
      if (this.sandbox) {
        console.log('[CBE SANDBOX] order:', orderId, amount);
        return {
          success: true,
          sandbox: true,
          orderId,
          checkoutUrl: `https://sandbox.cbe.com.et/pay?orderId=${orderId}&amount=${amount}&phone=${phone}`
        };
      }
      const res = await axios.post(`${this.baseUrl}/api/v1/payment/create`, payload, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
        timeout: 15000
      });
      return {
        success: res.data.success,
        orderId,
        checkoutUrl: res.data.data?.paymentUrl,
        rawResponse: res.data
      };
    } catch (e) {
      console.error('CBE createOrder error:', e.message);
      return { success: false, error: e.message, sandbox: this.sandbox };
    }
  }

  async queryOrder(orderId) {
    const payload = { merchantCode: this.merchantCode, orderId, timestamp: Date.now() };
    payload.signature = this.sign(payload);

    try {
      if (this.sandbox) return { success: true, status: 'PENDING', sandbox: true };
      const res = await axios.post(`${this.baseUrl}/api/v1/payment/query`, payload, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
        timeout: 10000
      });
      return {
        success: res.data.success,
        status: res.data.data?.status,
        rawResponse: res.data
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  verifyWebhook(body, signature) {
    if (this.sandbox) return true;
    if (!this.publicKey) {
      console.error('❌ CBE: የህዝብ ቁልፍ የለም');
      return false;
    }
    try {
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(JSON.stringify(body));
      verifier.end();
      return verifier.verify(this.publicKey, signature, 'base64');
    } catch (e) {
      console.error('CBE webhook verify error:', e);
      return false;
    }
  }
}

module.exports = CBEBirr;
