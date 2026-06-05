(function () {
  const api = 'https://ghostreply-api.rampell.workers.dev';
  const checkoutBase = 'https://ghostreply.lemonsqueezy.com/checkout/buy/877e5f9a-3f63-4b5e-84f2-95e624643828';
  const params = new URLSearchParams(window.location.search);
  const page = document.body.dataset.page || 'landing';
  const sourceId = (() => {
    try {
      const existing = localStorage.getItem('ghostreply_source_id');
      if (existing) return existing;
      const next = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem('ghostreply_source_id', next);
      localStorage.setItem('ghostreply_landing_url', window.location.href);
      localStorage.setItem('ghostreply_initial_referrer', document.referrer || '$direct');
      return next;
    } catch {
      return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
  })();

  function sourceValue(name) {
    return params.get(name) || '';
  }

  function event(name, properties = {}) {
    try {
      navigator.sendBeacon(
        `${api}/v1/events`,
        new Blob([JSON.stringify({
          event: name,
          distinct_id: `site_${sourceId}`,
          properties: {
            source_id: sourceId,
            page,
            landing_url: localStorage.getItem('ghostreply_landing_url') || window.location.href,
            referrer: localStorage.getItem('ghostreply_initial_referrer') || document.referrer || '$direct',
            current_url: window.location.href,
            utm_source: sourceValue('utm_source'),
            utm_medium: sourceValue('utm_medium'),
            utm_campaign: sourceValue('utm_campaign'),
            utm_content: sourceValue('utm_content'),
            utm_term: sourceValue('utm_term'),
            ...properties,
          },
        })], { type: 'application/json' })
      );
    } catch {}
  }

  function checkoutUrl(buttonId) {
    const url = new URL(checkoutBase);
    const custom = {
      source_id: sourceId,
      landing_url: localStorage.getItem('ghostreply_landing_url') || window.location.href,
      referrer: localStorage.getItem('ghostreply_initial_referrer') || document.referrer || '$direct',
      button_id: buttonId,
      utm_source: sourceValue('utm_source'),
      utm_medium: sourceValue('utm_medium'),
      utm_campaign: sourceValue('utm_campaign'),
      utm_content: sourceValue('utm_content'),
      utm_term: sourceValue('utm_term'),
    };
    Object.entries(custom).forEach(([key, value]) => {
      if (value) url.searchParams.set(`checkout[custom][${key}]`, String(value).slice(0, 500));
    });
    return url.toString();
  }

  document.querySelectorAll('[data-checkout]').forEach((button) => {
    button.addEventListener('click', (eventObject) => {
      eventObject.preventDefault();
      const buttonId = button.dataset.checkout || `${page}_checkout`;
      event('checkout_clicked', { button_id: buttonId });
      window.location.href = checkoutUrl(buttonId);
    });
  });

  document.querySelectorAll('[data-copy-install]').forEach((button) => {
    button.addEventListener('click', () => {
      navigator.clipboard.writeText('curl -sL ghostreply.lol/install.sh | bash');
      button.textContent = 'Copied: curl -sL ghostreply.lol/install.sh | bash';
      event('install_copied', {});
    });
  });

  event('site_pageview', {});
})();
