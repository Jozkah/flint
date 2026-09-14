/**
 * Typed client for the first-launch JAN -> Flint migration.
 *
 * Thin wrappers over the six desktop Tauri commands in
 * `src-tauri/src/core/migration` (registered in `src-tauri/src/lib.rs`). The
 * Rust core is the source of truth; this module only mirrors its serde shapes
 * (all `snake_case`) and forwards calls. Nothing here does filesystem work.
 */
import { invoke } from '@tauri-apps/api/core'

/** How the migration treats the source JAN data. */
export type MigrationMode = 'copy' | 'reuse' | 'move' | 'fresh'

/** Resolution for a destination item that already exists in Flint. */
export type Conflict = 'keep_flint' | 'use_jan' | 'keep_both'

/** A migratable data category (matches the Rust `Category` serde form). */
export type Category =
  | 'conversations'
  | 'models'
  | 'configs'
  | 'settings'
  | 'common'
  | 'agent'

/** Overall migration status (Rust `Status`). */
export type MigrationStatus =
  | 'pending'
  | 'in_progress'
  | 'complete'
  | 'dismissed'
  | 'failed'

export interface CategoryReport {
  category: Category
  size_bytes: number
  file_count: number
  status: string
}

export interface ResolvedSource {
  config_dir: string
  data_folder: string
  location: string
}

export interface LegacyData {
  source: ResolvedSource
  total_size_bytes: number
  schema_version: number | null
  categories: CategoryReport[]
}

export interface DetectResult {
  found: boolean
  first_launch_pending: boolean
  legacy: LegacyData | null
}

export interface ConflictInfo {
  existing: string
  jan_mtime_ms: number | null
  flint_mtime_ms: number | null
  flint_is_newer: boolean
  resolution: Conflict
}

export interface PlannedItem {
  category: Category
  name: string
  root: string
  source: string
  destination: string
  is_dir: boolean
  size_bytes: number
  conflict: ConflictInfo | null
}

export interface MigrationPlan {
  mode: MigrationMode
  source_config_dir: string
  source_data_folder: string
  dest_config_dir: string
  dest_data_folder: string
  selected_categories: Category[]
  items: PlannedItem[]
  reuse_path: string | null
  estimated_bytes: number
  compatible: boolean
  warnings: string[]
}

export interface CategoryResult {
  category: Category
  ok_count: number
  skipped_count: number
  failed_count: number
  done: boolean
}

export interface SkippedItem {
  path: string
  reason: string
}

export interface MigrationResult {
  status: MigrationStatus
  mode: MigrationMode
  per_category: CategoryResult[]
  skipped: SkippedItem[]
  backup_path: string | null
  reuse_path: string | null
  quarantine_dir: string | null
  manifest_path: string
  error: string | null
  rolled_back: boolean
}

export interface MigrationManifest {
  selected_categories: Category[]
  mode: MigrationMode
  status: MigrationStatus
  backup_path: string | null
  reuse_path: string | null
  started_at: number
  finished_at: number | null
}

/** The categories in the stable order the core migrates them. */
export const ALL_CATEGORIES: Category[] = [
  'settings',
  'configs',
  'conversations',
  'agent',
  'common',
  'models',
]

export const MODE_LABELS: Record<MigrationMode, string> = {
  copy: 'Copy to Flint',
  reuse: 'Reuse JAN data',
  move: 'Move to Flint',
  fresh: 'Start fresh',
}

export const MODE_DESCRIPTIONS: Record<MigrationMode, string> = {
  copy: 'Duplicate the selected JAN data into Flint. Your JAN install is left untouched.',
  reuse: 'Point Flint at your existing JAN data in place, without copying it.',
  move: 'Copy into Flint, then remove the JAN source once every item succeeds. A backup is kept so you can roll back.',
  fresh: 'Begin with an empty Flint profile. Nothing in JAN is read or changed.',
}

export const CATEGORY_LABELS: Record<Category, string> = {
  conversations: 'Conversations & assistants',
  models: 'Downloaded models & engines',
  configs: 'Configuration files',
  settings: 'Settings & provider credentials',
  common: 'Extensions, logs & caches',
  agent: 'Agent workspace & rooms',
}

export const CONFLICT_LABELS: Record<Conflict, string> = {
  keep_flint: 'Keep the existing Flint item',
  use_jan: 'Overwrite with the JAN item',
  keep_both: 'Keep both (JAN copy is suffixed)',
}

/** Human-readable byte size. */
export function formatBytes(n: number): string {
  if (!n || n < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

/** Detect a legacy JAN install and whether the first-launch prompt is due. */
export function migrationDetect(): Promise<DetectResult> {
  return invoke<DetectResult>('migration_detect')
}

/** Build (but do not run) a migration plan for the chosen mode. */
export function migrationPlan(args: {
  selectedCategories: Category[]
  mode: MigrationMode
  defaultConflict: Conflict
}): Promise<MigrationPlan> {
  return invoke<MigrationPlan>('migration_plan', args)
}

/** Execute a previously built plan. */
export function migrationExecute(plan: MigrationPlan): Promise<MigrationResult> {
  return invoke<MigrationResult>('migration_execute', { plan })
}

/** The current manifest, if any. */
export function migrationStatus(): Promise<MigrationManifest | null> {
  return invoke<MigrationManifest | null>('migration_status')
}

/** Roll back a completed/failed migration. */
export function migrationRollback(): Promise<void> {
  return invoke<void>('migration_rollback')
}

/** Dismiss the migration prompt; it is never offered again. */
export function migrationDismiss(): Promise<void> {
  return invoke<void>('migration_dismiss')
}
