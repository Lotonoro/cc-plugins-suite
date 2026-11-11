// Test support for the cut oracles, shared by the cut tests: imported by tests only, never by a module the plugin loads.
import { displayColumns } from './columns'

const JOINER = String.fromCodePoint(0x200d)

// Whether a text ends where a joiner still joins what comes next: its last U+200D is followed only by code points that draw no column, or by none.
export const endsJoining = (text: string): boolean => {
  const at = text.lastIndexOf(JOINER)
  return at !== -1 && [...text.slice(at + 1)].every(point => displayColumns(point) === 0)
}
