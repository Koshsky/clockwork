import type { ArgTypes } from '@storybook/vue3'

import type { UserPermissionsModel, PermissionOverride, PermissionCell } from './types'

/** Builds a sample editor model (an rp user with individual tweaks). */
export function sampleModel(): UserPermissionsModel {
  const presetScope: PermissionCell[] = [
    { resource: 'project', action: 'view', scope: 'self' },
    { resource: 'project', action: 'create', scope: 'self' },
    { resource: 'project', action: 'update', scope: 'self' },
    { resource: 'process', action: 'view', scope: 'up1' },
    { resource: 'process', action: 'create', scope: 'up1' },
    { resource: 'task', action: 'view', scope: 'up' },
    { resource: 'task', action: 'create', scope: 'up1' },
    { resource: 'worker', action: 'view', scope: 'self' },
    { resource: 'resource', action: 'view', scope: 'self' },
  ]
  const overrides: PermissionOverride[] = [
    { resource: 'task', action: 'delete', granted: false },
    { resource: 'project', action: 'view', scope: 'all', granted: true },
  ]
  const overrideByKey = new Map(overrides.map((o) => [`${o.resource}/${o.action}`, o]))
  const effective = presetScope
    .map((p) => {
      const ov = overrideByKey.get(`${p.resource}/${p.action}`)
      if (ov) return ov.granted ? { ...p, scope: ov.scope ?? 'all' } : null
      return p
    })
    .filter((p): p is PermissionCell => p != null)
  return { preset: 'rp', admin: false, presetScope, overrides, effective }
}

/** A sample admin model — read-only panel. */
export function sampleAdminModel(): UserPermissionsModel {
  const m = sampleModel()
  return { ...m, preset: 'admin', admin: true, overrides: [], presetScope: [], effective: [] }
}

export const argTypes = {
  userId: {
    control: { type: 'number' },
    description: 'User id in `user` mode — the editor loads the permissions from the RBAC store.',
    table: { type: { summary: 'number' } },
  },
  mode: {
    control: { type: 'select' },
    options: ['user', 'draft'],
    description: '`user` — an existing user (store by userId); `draft` — the create page (baseline from the preset).',
    table: { type: { summary: "'user' | 'draft'" } },
  },
  preset: {
    control: { type: 'text' },
    description:
      'Selected preset code. In `draft` mode it is the baseline of the rows; in `user` mode switching it immediately rebuilds the visible baseline (the rows below) over the stored overrides. The header select emits `update:preset`.',
    table: { type: { summary: 'string' } },
  },
  presetOptions: {
    control: { type: 'object' },
    description: 'Options of the preset switch in the block header (`{ value, label }[]`).',
    table: { type: { summary: '{ value: string; label: string }[]' } },
  },
  preview: {
    control: { type: 'object' },
    description: 'Static data preview (Storybook); the page passes the store data via userId.',
    table: { type: { summary: 'UserPermissionsModel | null' } },
  },
} satisfies ArgTypes