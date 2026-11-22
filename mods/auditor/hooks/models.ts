// Every fact about model names, as pure functions: the aliases and the full-id grammar, the list of choices, the choice a conversation takes, whether two names run one model, and the words that show one. It reads no state and no engine: `store.ts` and `catalog.ts` read what these functions are given.

// The names the spawn call takes as `model`, in the order they are offered. The default is the latest Haiku, so a new one is used without a plugin update; Fable is offered and never the default.
export const ALIASES: readonly string[] = ['haiku', 'sonnet', 'opus', 'fable']
export const DEFAULT_MODEL = 'haiku'

// A full id: `claude-<family>-<version>`, the version one number or two joined by `-`, then a date suffix (`-YYYYMMDD` or `@YYYYMMDD`) and a context suffix (`[1m]`), each optional. Any other name is an alias. The date is eight digits, a version part at most two, so the two never read as one another.
const FULL_ID = /^claude-([a-z]+)-(\d{1,2}(?:-\d{1,2})?)(?:[-@]\d{8})?(\[1m\])?$/

export const isFullId = (name: string): boolean => FULL_ID.test(name)

// A full id's canonical form: without its date suffix, with its context suffix, since a context variant may be priced apart. Undefined for a name that is not a full id.
export const canonicalOf = (name: string): string | undefined => {
  const parts = FULL_ID.exec(name)
  return parts === null ? undefined : `claude-${parts[1]}-${parts[2]}${parts[3] ?? ''}`
}

// Whether a name is Fable's, as the alias or as an id of its family.
export const isFable = (name: string): boolean => name === 'fable' || FULL_ID.exec(name)?.[1] === 'fable'

// What each alias last resolved to, as a spawn result named it: the one place an alias gets an id. The catalog's own alias targets are never read, since they named a Fable the engine did not run.
export type ModelIds = Readonly<Record<string, string>>

// The chain from a choice to its canonical id: a full id is its own, an alias takes the id it last resolved to, or has none.
export const idOf = (choice: string, ids: ModelIds): string | undefined => {
  const own = canonicalOf(choice)
  if (own !== undefined) return own
  const stored = ids[choice]
  return typeof stored === 'string' ? canonicalOf(stored) : undefined
}

// Whether a pair of a choice and the full id its spawn resolved to is kept: only an alias gets one, and only for a full id. An alias stored as an id would make the chain answer an alias, and a full-id choice is its own id.
export const keepsPair = (choice: string, id: string): boolean => isFullId(id) && !isFullId(choice)

// Whether two choices run one model: the same name, or two names whose ids are both known and equal.
export const sameModel = (a: string, b: string, ids: ModelIds): boolean => {
  if (a === b) return true
  const id = idOf(a, ids)
  return id !== undefined && id === idOf(b, ids)
}

// The name the engine's catalog gives each of its models, by canonical id: what `/model` shows for it.
export type ModelNames = Readonly<Record<string, string>>

// What `/auditor model` may set: the names in the order they are shown, the default of a conversation that has chosen nothing, and whether `availableModels` removed every choice and was ignored for it. `names` are the display names of every catalog id, those a filter removed from the list too, since a name is a fact about a model and a held choice may lie outside the filter.
export type Choices = { list: readonly string[]; defaultChoice: string; filterIgnored: boolean; names: ModelNames }

// Whether a value is a list of strings: the shape of the names an `availableModels` setting holds.
export const isNames = (value: unknown): value is string[] => Array.isArray(value) && value.every(entry => typeof entry === 'string')

// Whether an `availableModels` entry names a choice: by its name, or by its canonical id, in any case.
const allows = (entry: string, name: string): boolean => {
  const wanted = entry.trim().toLowerCase()
  const known = canonicalOf(wanted)
  return wanted === name.toLowerCase() || (known !== undefined && known === canonicalOf(name))
}

// The default of a list: haiku while it is offered, else the first choice that is not Fable, else the first (only Fable is left, and the plugin must always have something to spawn on).
const defaultOf = (list: readonly string[]): string => (list.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : (list.find(name => !isFable(name)) ?? list[0] ?? DEFAULT_MODEL))

// The names a row may show, from the names the catalog gave each id: a name is used, trimmed, when it is non-empty once trimmed and holds no control character, since the popup draws a line per row and a value that could break the line is not drawn. A name more than one id has, once trimmed, names none of them: it does not say which model runs.
const displayNames = (given: ModelNames): ModelNames => {
  const usable = Object.entries(given).filter(([, name]) => name.trim() !== '' && !/\p{Cc}/u.test(name)).map(([id, name]) => [id, name.trim()] as const)
  const holders = new Map<string, number>()
  for (const [, name] of usable) holders.set(name, (holders.get(name) ?? 0) + 1)
  return Object.fromEntries(usable.filter(([, name]) => holders.get(name) === 1))
}

// The choices: the four aliases, then the catalog's ids in the catalog's order. A catalog id is its own choice, so an id an alias resolves to is offered by that id too. `available`, a value read from the `availableModels` setting, filters the list when it is a list of names; one that is not counts as unset, and one that leaves no choice is ignored. `names` are the catalog's names for its ids, which `displayNames` checks; a caller with none reads the choices without names.
export const choicesOf = (catalog: readonly string[] | undefined, available: unknown, names: ModelNames = {}): Choices => {
  const all = [...ALIASES, ...(catalog ?? [])]
  const entries = isNames(available) ? available : undefined
  const kept = entries === undefined ? all : all.filter(name => entries.some(entry => allows(entry, name)))
  const list = kept.length === 0 ? all : kept
  return { list, defaultChoice: defaultOf(list), filterIgnored: entries !== undefined && kept.length === 0, names: displayNames(names) }
}

// The choices where no catalog or setting could be read.
export const FALLBACK_CHOICES: Choices = choicesOf(undefined, undefined)

// The name in the list's spelling, whatever case it was given in, or undefined when the list does not offer it.
export const offered = (list: readonly string[], name: string): string | undefined => list.find(choice => choice.toLowerCase() === name.toLowerCase())

// The choice a conversation holds from now on: the one it holds, else the last model set when the list still offers it, else the list's default. Every take uses it: the first spawn and the bare read.
export const takeChoice = (held: string | undefined, last: string | undefined, choices: Choices): string => {
  if (held !== undefined && held !== '') return held
  return (last === undefined ? undefined : offered(choices.list, last)) ?? choices.defaultChoice
}

// The words that show a choice: the name the catalog gives the id the chain gives it (`idOf`), else the choice as spelled, which is also what `/auditor model <name>` takes. An id with no name, a name more than one id has, an alias no spawn has resolved, and choices read without names all read as the spelling.
export const shownAs = (choice: string, ids: ModelIds, choices: Choices): string => {
  const id = idOf(choice, ids)
  return (id === undefined ? undefined : choices.names[id]) ?? choice
}
