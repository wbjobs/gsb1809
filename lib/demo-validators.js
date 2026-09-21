function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

export const asyncValidators = {
  async usernameAvailability(request, context) {
    await delay(450, context.signal);
    const username = String(request.value ?? '').trim().toLowerCase();
    const reserved = new Set(['admin', 'root', 'system', 'worker']);
    if (reserved.has(username)) return { valid: false, code: 'USERNAME_TAKEN', message: `${request.value} is already reserved.` };
    return { valid: true };
  },

  async postalCodeAvailability(request, context) {
    await delay(600, context.signal);
    const country = String(request.payload.country ?? request.dependencies?.country ?? 'CN');
    const code = String(request.value ?? '');
    if (country === 'CN' && !/^\d{6}$/.test(code)) {
      return { valid: false, code: 'CN_POSTAL_CODE', message: 'China postal code must contain exactly 6 digits.' };
    }
    if (country === 'US' && !/^\d{5}(-\d{4})?$/.test(code)) {
      return { valid: false, code: 'US_ZIP_CODE', message: 'US ZIP code must be 12345 or 12345-6789.' };
    }
    return { valid: true };
  },

  async failingRemote() {
    await delay(100);
    throw new Error('Remote validation service is unavailable.');
  },

  async slowRemote(request, context) {
    await delay(Number(request.payload?.ms ?? 10000), context.signal);
    return { valid: true };
  }
};
