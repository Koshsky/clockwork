'use strict'

// Keep executable code local. Dynamic Gantt styles and captured PDF images
// require inline CSS and data URLs, but never inline JavaScript or eval.
const common = {
  'default-src': ["'none'"],
  'script-src': ["'self'"],
  'script-src-attr': ["'none'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'https://service.mvsservice.ru'],
  'font-src': ["'self'", 'data:'],
  'worker-src': ["'self'"],
  'frame-src': ["'self'"],
  'manifest-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
}

function policy(connect) {
  return Object.entries({ ...common, 'connect-src': connect })
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ')
}

const webPolicy = policy(["'self'"])
// The desktop server address is editable at runtime, including local HTTP
// installations. Only network requests get this exception, never scripts.
const desktopPolicy = policy(["'self'", 'https:', 'http:'])

function securityHeaders(contentSecurityPolicy = desktopPolicy) {
  return {
    'Content-Security-Policy': contentSecurityPolicy,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  }
}

module.exports = { webPolicy, desktopPolicy, securityHeaders }
