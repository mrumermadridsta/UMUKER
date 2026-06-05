/**
 * Telebirr Payment Gateway Integration
 * 
 * Real Telebirr H5 Web Payment API integration.
 * Documentation: https://developerportal.ethiotelecom.et/
 * 
 * Sandbox credentials are included for testing.
 * For production, replace with your merchant credentials from Telebirr.
 */

const crypto = require('crypto');
const axios = require('axios');

class Telebirr {
  constructor(config = {}) {
    // Sandbox (test) credentials — replace with production
    this.appId = config.appId || process.env.TELEBIRR_APP_ID || 'YOUR_APP_ID';
    this.appKey = config.appKey || process.env.TELEBIRR_APP_KEY || 'YOUR_APP_KEY';
    this.merchantId = config.merchantId || process.env.TELEBIRR_MERCHANT_ID || 'YOUR_MERCHANT_ID';
    this.baseUrl = config.baseUrl || process.env.TELEBIRR_BASE_URL || 'https://developerportal.ethiotelecom.et:9443';
    this.privateKey = config.privateKey || process.env.TELEBIRR_PRIVATE_KEY;
    this.publicKey = config.publicKey || process.env.TELEBIRR_PUBLIC_KEY;
    this.sandbox = config.sandbox !== false;
  }

  /**
   * Generate RSA signature
   * Telebirr requires signing the request payload with merchant private key
   */
  sign(payload) {
    if (!this.privateKey) {
      // For sandbox/test mode, use a simple hash
      return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    }
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(JSON.stringify(payload));
    sign.end();
    return sign.sign(this.privateKey, 'base64');
  }

  /**
   * Create H5 Web Payment order
   * Returns checkout URL that user should be redirected to
   */
  async createOrder({ orderId, amount, subject, phone, returnUrl, notifyUrl }) {
    const timeoutExpress = '30m';
    const timestamp = Date.now();
    
    const payload = {
      appId: this.appId,
      merchantId: this.merchantId,
      nonceStr: crypto.randomBytes(16).toString('hex'),
      timestamp,
      orderId,
      totalAmount: amount.toString(),
      subject: subject || 'Bingo Top-up',
      phone,
      timeoutExpress,
      returnUrl: returnUrl || 'https://your-domain.com/wallet',
      notifyUrl: notifyUrl || 'https://your-domain.com/api/payment/telebirr/webhook'
    };

    const sign = this.sign(payload);
    payload.sign = sign;

    try {
      if (this.sandbox) {
        // Sandbox mode: simulate success
        console.log('[Telebirr SANDBOX] createOrder:', orderId, amount, phone);
        return {
          success: true,
          sandbox: true,
          orderId,
          checkoutUrl: `telebirr://payment?orderId=${orderId}&amount=${amount}&phone=${phone}`,
          payload
        };
      }

      const res = await axios.post(`${this.baseUrl}/payment/v1/merchant/web/h5create`, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      });

      return {
        success: res.data.code === '0',
        orderId,
        checkoutUrl: res.data.data?.checkoutUrl,
        rawResponse: res.data
      };
    } catch (e) {
      console.error('Telebirr createOrder error:', e.message);
      return { success: false, error: e.message, sandbox: this.sandbox };
    }
  }

  /**
   * Query order status
   */
  async queryOrder(orderId) {
    const payload = {
      appId: this.appId,
      merchantId: this.merchantId,
      orderId,
      timestamp: Date.now(),
      nonceStr: crypto.randomBytes(16).toString('hex')
    };
    payload.sign = this.sign(payload);

    try {
      if (this.sandbox) {
        return { success: true, status: 'PENDING', sandbox: true };
      }
      const res = await axios.post(`${this.baseUrl}/payment/v1/merchant/query`, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      });
      return {
        success: res.data.code === '0',
        status: res.data.data?.orderStatus,  // PENDING / SUCCESS / FAILED / CANCELLED
        rawResponse: res.data
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Verify webhook signature from Telebirr
   * Called when Telebirr sends payment notification
   */
  verifyWebhook(body, signature) {
    if (this.sandbox) return true;
    try {
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(JSON.stringify(body));
      verifier.end();
      return verifier.verify(this.publicKey, signature, 'base64');
    } catch (e) {
      console.error('Webhook verify error:', e);
      return false;
    }
  }

  /**
   * Refund an order
   */
  async refund({ orderId, refundAmount, reason }) {
    const payload = {
      appId: this.appId,
      merchantId: this.merchantId,
      orderId,
      refundAmount: refundAmount.toString(),
      reason: reason || 'User requested',
      timestamp: Date.now(),
      nonceStr: crypto.randomBytes(16).toString('hex')
    };
    payload.sign = this.sign(payload);

    try {
      if (this.sandbox) {
        return { success: true, sandbox: true };
      }
      const res = await axios.post(`${this.baseUrl}/payment/v1/merchant/refund`, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      });
      return { success: res.data.code === '0', rawResponse: res.data };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}

module.exports = Telebirr;
