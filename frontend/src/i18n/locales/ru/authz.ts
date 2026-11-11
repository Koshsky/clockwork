/**
 * Russian catalog — display helpers of the access-control layer: fallback names
 * of the seeded built-in permission presets and the human-readable scope words
 * (utils/presets.ts, rbacScope.ts).
 */
export default {
  preset: {
    admin: 'Администратор',
    dp: 'Директор проектов',
    rp: 'Руководитель проекта',
    vp: 'Владелец процесса',
    worker: 'Работник',
  },
  scope: {
    notSet: 'не задано',
    all: 'всё',
    forbidden: 'запрещено',
    self: 'свои',
    parents: 'родители',
    ancestors: 'по цепочке владельцев',
    ancestors2: 'по цепочке владельцев до 2 уровней',
    subtree: 'связанные',
    subtree2: 'связанные до 2 уровней',
    projectPeers: 'по общему проекту',
    siblings: 'сиблинги',
    /** Unknown expression token, e.g. a custom move code. */
    unknown: '«{token}»',
    /** Separator between the moves of one expression. */
    join: ' + ',
  },
} as const
