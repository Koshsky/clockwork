'use strict'

const { isApplicationDocument } = require('./security.cjs')

function attachRendererRecovery(contents, { origin, active, onFailed, now = Date.now }) {
  let attempts = 0, since = now(), stopped = false
  const recover = (_, details) => {
    if (stopped || contents.isDestroyed() || !active() || details.reason === 'clean-exit') return
    const current = now()
    if (current - since >= 30000) { since = current; attempts = 0 }
    if (++attempts > 2) { onFailed(); return }
    let target = origin
    if (isApplicationDocument(contents.getURL(), origin)) target = contents.getURL()
    setImmediate(() => {
      if (stopped || contents.isDestroyed() || !active()) return
      void contents.loadURL(target).catch(() => { if (!stopped && !contents.isDestroyed() && active()) onFailed() })
    })
  }
  function stop() {
    if (stopped) return
    stopped = true
    contents.removeListener('render-process-gone', recover)
    contents.removeListener('destroyed', stop)
  }
  contents.on('render-process-gone', recover)
  contents.once('destroyed', stop)
  return stop
}
module.exports = { attachRendererRecovery }
