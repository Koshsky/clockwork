<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { t } from '@/i18n'
import { getApiUrl, setApiUrl, httpSchemeWarning } from '../config'
import { scheme, setScheme } from '../theme'
import { autoSync, saveSyncSettings } from '../settings'
import {
  notificationsEnabled,
  notifyDurationMs,
  NOTIFY_DURATION_OPTIONS,
  saveNotifySettings,
} from '../settings'
import {
  uiFontSize,
  applyUiSize,
  tablePageSize,
  TABLE_PAGE_SIZE_OPTIONS,
  saveUiSettings,
} from '../settings'
import { viewSettings, uiLanguage, SCALE_MIN, SCALE_MAX, SCALE_STEP, CELL_ZOOM_MIN, CELL_ZOOM_MAX, CELL_ZOOM_STEP, PROJECT_DAYS_MIN, PROJECT_DAYS_MAX } from '../settings'
import { BarBadgesPreview } from '@/components/planner/BarBadgesPreview'
import { DependencyStylePreview } from '@/components/planner/DependencyStylePreview'
import { linkStyleOptions } from '@/components/planner/linkStyleLabels'
import { notifyError, notifyInfo, notifySuccess } from '../notify/state'

type SettingsSection = 'interface' | 'tables' | 'diagrams' | 'server'

const activeSection = ref<SettingsSection>('interface')

/** Section switcher labels; rebuilt on a language switch. */
const sections = computed<{ id: SettingsSection; label: string }[]>(() => [
  { id: 'interface', label: t('adminSystem.settings.sections.interface') },
  { id: 'diagrams', label: t('adminSystem.settings.sections.diagrams') },
  { id: 'tables', label: t('adminSystem.settings.sections.tables') },
  { id: 'server', label: t('adminSystem.settings.sections.server') },
])

/** Connector style options; rebuilt on a language switch. */
const connectorOptions = computed(() => linkStyleOptions())

const apiUrl = ref('')

/** Clamps the typed project duration into the allowed range (empty/invalid → default). */
function normalizeProjectDays() {
  const raw = viewSettings.defaultProjectDays
  if (!Number.isFinite(raw)) {
    viewSettings.defaultProjectDays = 180
    return
  }
  viewSettings.defaultProjectDays = Math.min(
    PROJECT_DAYS_MAX,
    Math.max(PROJECT_DAYS_MIN, Math.round(raw)),
  )
}

/** Enter in the number field commits the value and closes editing. */
function onProjectDaysEnter(e: KeyboardEvent) {
  normalizeProjectDays()
  ;(e.target as HTMLInputElement).blur()
}

/** Applies the URL from the field to the runtime config; false — invalid URL */
function applyApiUrl(): boolean {
  const warn = httpSchemeWarning(apiUrl.value)
  if (warn) notifyInfo(warn)
  const applied = setApiUrl(apiUrl.value, true)
  if (!applied) {
    notifyError(t('adminSystem.settings.connection.invalid'))
  }
  return applied
}

/** The "Save" button for API_URL: validates and saves to localStorage */
function onSaveApiUrl() {
  if (!applyApiUrl()) return
  notifySuccess(t('adminSystem.settings.connection.saved'))
}

watch(autoSync, saveSyncSettings)
watch([notificationsEnabled, notifyDurationMs], saveNotifySettings)
watch([uiFontSize, tablePageSize], () => {
  applyUiSize()
  saveUiSettings()
})
watch(scheme, (value) => setScheme(value))

onMounted(() => {
  apiUrl.value = getApiUrl() ?? ''
})
</script>

<template>
  <section class="st">
    <h2 class="st-title">{{ t('adminSystem.settings.title') }}</h2>

    <!-- Section switcher: segmented control -->
    <div class="st-seg" role="tablist" :aria-label="t('adminSystem.settings.sectionsAria')">
      <button
        v-for="sec in sections"
        :key="sec.id"
        type="button"
        role="tab"
        class="st-seg-tab"
        :class="{ on: activeSection === sec.id }"
        :aria-selected="activeSection === sec.id"
        @click="activeSection = sec.id"
      >
        {{ sec.label }}
      </button>
    </div>

    <!-- Interface -->
    <template v-if="activeSection === 'interface'">
      <div class="st-card">
        <h3 class="st-card-title">{{ t('adminSystem.settings.interface.title') }}</h3>
        <div class="st-field">
          <span>{{ t('adminSystem.settings.interface.theme') }}</span>
          <select v-model="scheme" class="st-select">
            <option value="system">{{ t('adminSystem.settings.interface.themeSystem') }}</option>
            <option value="light">{{ t('adminSystem.settings.interface.themeLight') }}</option>
            <option value="dark">{{ t('adminSystem.settings.interface.themeDark') }}</option>
          </select>
        </div>
        <div class="st-field">
          <span>{{ t('adminSystem.settings.interface.fontSize') }}</span>
          <select v-model="uiFontSize" class="st-select">
            <option value="small">{{ t('adminSystem.settings.interface.fontSizeSmall') }}</option>
            <option value="default">{{ t('adminSystem.settings.interface.fontSizeDefault') }}</option>
            <option value="large">{{ t('adminSystem.settings.interface.fontSizeLarge') }}</option>
          </select>
        </div>
        <div class="st-field">
          <span>{{ t('adminSystem.settings.interface.language') }}</span>
          <select v-model="uiLanguage" class="st-select">
            <option value="auto">{{ t('adminSystem.settings.interface.languageAuto') }}</option>
            <option value="ru">{{ t('adminSystem.settings.interface.languageRu') }}</option>
            <option value="en">{{ t('adminSystem.settings.interface.languageEn') }}</option>
          </select>
        </div>
      </div>

      <div class="st-card">
        <h3 class="st-card-title">{{ t('adminSystem.settings.notifications.title') }}</h3>
        <label class="st-option">
          <input v-model="notificationsEnabled" type="checkbox" />
          <span>{{ t('adminSystem.settings.notifications.enabled') }}</span>
        </label>
        <div class="st-field">
          <span>{{ t('adminSystem.settings.notifications.duration') }}</span>
          <select v-model.number="notifyDurationMs" class="st-select">
            <option v-for="ms in NOTIFY_DURATION_OPTIONS" :key="ms" :value="ms">
              {{ t('adminSystem.settings.notifications.durationSeconds', { seconds: ms / 1000 }) }}
            </option>
            <option :value="0">{{ t('adminSystem.settings.notifications.durationNever') }}</option>
          </select>
          <p class="st-hint">{{ t('adminSystem.settings.notifications.durationHint') }}</p>
        </div>
      </div>
    </template>

    <!-- Diagrams -->
    <template v-if="activeSection === 'diagrams'">
      <div class="st-cards">
        <div class="st-card">
          <h3 class="st-card-title">{{ t('adminSystem.settings.appearance.title') }}</h3>

          <h4 class="st-group-title">{{ t('adminSystem.settings.badges.title') }}</h4>
          <fieldset class="st-badge-group" data-badge-group="project">
            <legend class="st-badge-title">{{ t('adminSystem.settings.badges.projectGroup') }}</legend>
            <BarBadgesPreview kind="project" />
            <div class="st-badge-options">
              <label class="st-option">
                <input v-model="viewSettings.badgeProjectOwner" type="checkbox" />
                <span>{{ t('adminSystem.settings.badges.projectOwner') }}</span>
              </label>
              <label class="st-option">
                <input v-model="viewSettings.badgeProjectResponsible" type="checkbox" />
                <span>{{ t('adminSystem.settings.badges.projectResponsible') }}</span>
              </label>
            </div>
          </fieldset>
          <fieldset class="st-badge-group" data-badge-group="process">
            <legend class="st-badge-title">{{ t('adminSystem.settings.badges.processGroup') }}</legend>
            <BarBadgesPreview kind="process" />
            <div class="st-badge-options">
              <label class="st-option">
                <input v-model="viewSettings.badgeProcessProjectCode" type="checkbox" />
                <span>{{ t('adminSystem.settings.badges.projectCode') }}</span>
              </label>
              <label class="st-option">
                <input v-model="viewSettings.badgeProcessOwner" type="checkbox" />
                <span>{{ t('adminSystem.settings.badges.processOwner') }}</span>
              </label>
              <label class="st-option">
                <input v-model="viewSettings.badgeProcessResponsible" type="checkbox" />
                <span>{{ t('adminSystem.settings.badges.processResponsible') }}</span>
              </label>
            </div>
          </fieldset>
          <fieldset class="st-badge-group" data-badge-group="task">
            <legend class="st-badge-title">{{ t('adminSystem.settings.badges.taskGroup') }}</legend>
            <BarBadgesPreview kind="task" />
            <div class="st-badge-options">
              <label class="st-option">
                <input v-model="viewSettings.badgeTaskProjectCode" type="checkbox" />
                <span>{{ t('adminSystem.settings.badges.projectCode') }}</span>
              </label>
              <label class="st-option">
                <input v-model="viewSettings.badgeTaskOwner" type="checkbox" />
                <span>{{ t('adminSystem.settings.badges.taskOwner') }}</span>
              </label>
              <label class="st-option">
                <input v-model="viewSettings.badgeTaskResponsible" type="checkbox" />
                <span>{{ t('adminSystem.settings.badges.taskResponsible') }}</span>
              </label>
              <label class="st-option">
                <input v-model="viewSettings.badgeResource" type="checkbox" />
                <span>{{ t('adminSystem.settings.badges.resource') }}</span>
              </label>
              <label class="st-option">
                <input v-model="viewSettings.badgeProgress" type="checkbox" />
                <span>{{ t('adminSystem.settings.badges.progress') }}</span>
              </label>
              <label class="st-option">
                <input v-model="viewSettings.badgeComments" type="checkbox" />
                <span>{{ t('adminSystem.settings.badges.comments') }}</span>
              </label>
            </div>
          </fieldset>

          <h4 class="st-group-title">{{ t('adminSystem.settings.appearance.linksGroup') }}</h4>
          <div class="st-field">
            <select
              v-model="viewSettings.connector"
              class="st-select"
              :aria-label="t('adminSystem.settings.defaults.connector')"
            >
              <option v-for="o in connectorOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <DependencyStylePreview :connector="viewSettings.connector" />
          </div>
        </div>

        <div class="st-card">
          <h3 class="st-card-title">{{ t('adminSystem.settings.defaults.title') }}</h3>
          <div class="st-field">
            <span>{{ t('adminSystem.settings.defaults.scale') }}</span>
            <div class="st-scale-row">
              <input
                v-model.number="viewSettings.defaultScale"
                type="range"
                :min="SCALE_MIN"
                :max="SCALE_MAX"
                :step="SCALE_STEP"
                class="st-scale"
              />
              <span class="st-scale-value">{{ viewSettings.defaultScale }}%</span>
            </div>
          </div>
          <div class="st-field">
            <span>{{ t('adminSystem.settings.defaults.cellZoom') }}</span>
            <div class="st-scale-row">
              <input
                v-model.number="viewSettings.defaultCellZoom"
                type="range"
                :min="CELL_ZOOM_MIN"
                :max="CELL_ZOOM_MAX"
                :step="CELL_ZOOM_STEP"
                class="st-scale"
              />
              <span class="st-scale-value">{{ viewSettings.defaultCellZoom }}%</span>
            </div>
          </div>
          <!-- Two short related fields share one row -->
          <div class="st-field-row">
            <div class="st-field">
              <span>{{ t('adminSystem.settings.defaults.projectDays') }}</span>
              <div class="st-num-row">
                <input
                  v-model.number="viewSettings.defaultProjectDays"
                  type="number"
                  :min="PROJECT_DAYS_MIN"
                  :max="PROJECT_DAYS_MAX"
                  step="1"
                  class="st-num"
                  :aria-label="t('adminSystem.settings.defaults.projectDaysAria')"
                  @blur="normalizeProjectDays"
                  @keydown.enter="onProjectDaysEnter"
                />
                <span class="st-num-unit">{{ t('adminSystem.settings.defaults.daysUnit') }}</span>
              </div>
            </div>
            <div class="st-field">
              <span>{{ t('adminSystem.settings.defaults.unit') }}</span>
              <div class="st-radio-row">
                <label class="st-radio">
                  <input v-model="viewSettings.defaultUnit" type="radio" value="day" />
                  <span>{{ t('adminSystem.settings.defaults.unitDay') }}</span>
                </label>
                <label class="st-radio">
                  <input v-model="viewSettings.defaultUnit" type="radio" value="week" />
                  <span>{{ t('adminSystem.settings.defaults.unitWeek') }}</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <div class="st-card">
          <h3 class="st-card-title">{{ t('adminSystem.settings.export.title') }}</h3>
          <label class="st-option">
            <input v-model="viewSettings.showPdfButtons" type="checkbox" />
            <span>{{ t('adminSystem.settings.export.pdfButtons') }}</span>
          </label>
          <p class="st-hint">{{ t('adminSystem.settings.export.hotkeyHint') }}</p>
        </div>
      </div>
    </template>

    <!-- Tables -->
    <template v-if="activeSection === 'tables'">
      <div class="st-card">
        <h3 class="st-card-title">{{ t('adminSystem.settings.tables.title') }}</h3>
        <div class="st-field">
          <span>{{ t('adminSystem.settings.tables.pageSize') }}</span>
          <select v-model.number="tablePageSize" class="st-select">
            <option v-for="n in TABLE_PAGE_SIZE_OPTIONS" :key="n" :value="n">{{ n }}</option>
          </select>
          <p class="st-hint">
            {{ t('adminSystem.settings.tables.pageSizeHint') }}
          </p>
        </div>
      </div>
    </template>

    <!-- Server: sync and connection in a single card -->
    <template v-if="activeSection === 'server'">
      <div class="st-card">
        <h3 class="st-card-title">{{ t('adminSystem.settings.server.title') }}</h3>

        <h4 class="st-group-title">{{ t('adminSystem.settings.sync.title') }}</h4>
        <label class="st-option">
          <input v-model="autoSync" type="checkbox" />
          <span>{{ t('adminSystem.settings.sync.auto') }}</span>
        </label>

        <h4 class="st-group-title">{{ t('adminSystem.settings.connection.title') }}</h4>
        <label class="st-field">
          <span>{{ t('adminSystem.settings.connection.apiUrl') }}</span>
          <input
            v-model="apiUrl"
            type="text"
            spellcheck="false"
            :placeholder="t('adminSystem.settings.connection.apiUrlPlaceholder')"
          />
        </label>
        <div class="st-actions st-actions--tight">
          <button type="button" class="st-btn st-btn--sm" @click="onSaveApiUrl">
            {{ t('common.save') }}
          </button>
        </div>
      </div>
    </template>

    </section>
</template>

<style scoped>
@import '../styles/tokens.css';

.st-title {
  font-size: calc(var(--ui-font-scale, 1) * 24px);
  font-weight: 700;
  color: var(--ui-text);
  margin-bottom: 20px;
}

/* Section switcher — segmented control.
 * Sized as a primary control: the tabs are at least 40px tall (44px at the
 * "large" interface font size), i.e. level with the inputs on this screen
 * instead of smaller than them. `min-height` rather than padding alone keeps
 * the height independent of font metrics and evens out tab widths. */
.st-seg {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  width: fit-content;
  background: var(--ui-surface-2);
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  padding: 4px;
  margin-bottom: 18px;
}
.st-seg-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: calc(var(--ui-font-scale, 1) * 40px);
  border: none;
  background: transparent;
  color: var(--ui-text-2);
  font: inherit;
  font-size: calc(var(--ui-font-scale, 1) * 15px);
  font-weight: 600;
  padding: 10px 22px;
  border-radius: 8px;
  cursor: pointer;
  transition: background var(--ui-duration), color var(--ui-duration);
}
.st-seg-tab:hover {
  color: var(--ui-text);
}
.st-seg-tab.on {
  background: var(--ui-surface);
  color: var(--ui-text);
  box-shadow: var(--ui-shadow-sm);
}

/* Two columns on wide screens: the cards use the free space to the right of the
   640px column instead of stacking (the calendar card sits next to the badges). */
.st-cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 640px));
  gap: 12px;
  align-items: start;
}

@media (max-width: 1024px) {
  .st-cards {
    grid-template-columns: minmax(0, 640px);
  }
}

.st-cards .st-card {
  margin-bottom: 0;
}

.st-card {
  background: var(--ui-surface);
  border-radius: var(--ui-radius-md);
  box-shadow: var(--ui-shadow-md);
  padding: 20px;
  margin-bottom: 12px;
  /* Settings read best as neat, bounded cards — not full-width slabs */
  box-sizing: border-box;
  width: 100%;
  max-width: 640px;
}

.st-card-title {
  font-size: calc(var(--ui-font-scale, 1) * 18px);
  font-weight: 700;
  color: var(--ui-text);
  margin: 0 0 16px;
}

/* Group heading inside a card that carries more than one group of settings. */
.st-badge-group {
  min-width: 0;
  margin: 16px 0 0;
  padding: 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
}
.st-badge-title {
  margin: 0;
  padding: 0 4px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 600;
  color: var(--ui-text);
}
.st-badge-options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  margin-top: 12px;
}
.st-badge-options .st-option {
  margin: 0;
}
.st-group-title {
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-weight: 600;
  color: var(--ui-text);
  margin: 0 0 8px;
}

.st-group-title:not(:first-of-type) {
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--ui-border);
}

.st-hint {
  margin: 0 0 12px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: var(--ui-text-muted);
}

.st-option {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: var(--ui-text-2);
  cursor: pointer;
}

.st-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 600;
  color: var(--ui-text-2);
}

.st-field input[type='text'],
.st-field input[type='password'],
.st-field input[type='number'] {
  padding: 11px 14px;
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-weight: 400;
  transition: border-color var(--ui-duration), box-shadow var(--ui-duration);
}

/* Select in the Notifications card (same visual language as the fields) */
.st-select {
  padding: 9px 12px;
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-family: inherit;
  font-weight: 400;
  color: var(--ui-text);
  background: var(--ui-surface);
  outline: none;
  transition: border-color var(--ui-duration), box-shadow var(--ui-duration);
}
.st-select:focus {
  border-color: var(--ui-accent);
  box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.15);
}

.st-field input:focus {
  outline: none;
  border-color: var(--ui-accent);
  box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.15);
}

.st-btn {
  margin-top: 14px;
  width: 100%;
  padding: 12px;
  border: none;
  border-radius: var(--ui-radius-sm);
  background: var(--ui-accent);
  color: var(--ui-accent-on);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--ui-duration), opacity var(--ui-duration);
}

.st-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-accent) 88%, black);
}

.st-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.st-btn.danger {
  background: var(--ui-danger);
}

.st-btn.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-danger) 88%, black);
}

.st-btn--sm {
  width: auto;
  margin-top: 0;
  padding: 9px 16px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
}

.st-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 4px;
}

.st-actions--tight {
  margin-top: 0;
}

.st-radio {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 500;
  color: var(--ui-text-2);
  cursor: pointer;
  padding: 5px 0;
}
.st-scale-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 0;
}
.st-scale {
  flex: 1;
  min-width: 0;
  accent-color: var(--ui-accent);
  cursor: pointer;
}
.st-scale-value {
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 700;
  color: var(--ui-text);
  font-variant-numeric: tabular-nums;
  min-width: 48px;
  text-align: right;
}
/* Two short related fields on one row (default project duration + calendar unit).
   They wrap into a column when the card gets too narrow. */
.st-field-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0 24px;
}
.st-field-row .st-field {
  flex: 1 1 240px;
  min-width: 0;
}
.st-radio-row {
  display: flex;
  gap: 16px;
}
/* Number input for the default project duration (typed, not a slider) */
.st-num-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.st-num {
  box-sizing: border-box;
  width: 110px;
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  padding: 8px 10px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-family: inherit;
  color: var(--ui-text);
  background: var(--ui-surface);
  outline: none;
  transition: border-color var(--ui-duration), box-shadow var(--ui-duration);
}
.st-num:focus {
  border-color: var(--ui-accent);
  box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.12);
}
.st-num-unit {
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: var(--ui-text-2);
}
</style>
