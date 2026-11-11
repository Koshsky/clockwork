import type ru from '../ru/authz'
import type { Translation } from '../types'

/** English catalog mirroring locales/ru/authz.ts. */
export default {
  preset: {
    admin: 'Administrator',
    dp: 'Project director',
    rp: 'Project manager',
    vp: 'Process owner',
    worker: 'Employee',
  },
  scope: {
    notSet: 'not set',
    all: 'all',
    forbidden: 'forbidden',
    self: 'own',
    parents: 'parents',
    ancestors: 'by ownership chain',
    ancestors2: 'by ownership chain up to 2 levels',
    subtree: 'related',
    subtree2: 'related up to 2 levels',
    projectPeers: 'in the same project',
    siblings: 'siblings',
    unknown: '“{token}”',
    join: ' + ',
  },
} satisfies Translation<typeof ru>
