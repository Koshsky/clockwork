'use strict'

const fs = require('node:fs')
const path = require('node:path')
const schema = require('../../backend/docs/swagger/swagger.json')
const routes = Object.entries(schema.paths).flatMap(([route, methods]) =>
  route.startsWith('/auth/') ? [] : Object.entries(methods).map(([method, definition]) => ({
    operation: `${method.toUpperCase()} ${route}`, method: method.toUpperCase(), path: route,
    pathTypes: Object.fromEntries((definition.parameters || []).filter(item => item.in === 'path').map(item => [item.name, item.type])),
    query: (definition.parameters || []).filter(item => item.in === 'query').map(item => item.name),
  })))
const content = JSON.stringify(routes, null, 2) + '\n'
for (const target of [path.join(__dirname, '../desktop/api-routes.json'), path.join(__dirname, '../src/session/apiRoutes.json')]) {
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(target, 'utf8') !== content) throw new Error('Desktop API routes are stale')
  } else fs.writeFileSync(target, content)
}
