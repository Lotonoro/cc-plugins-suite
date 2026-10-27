// The reviewers' lookup into the session transcript: pure parts only, the host commands run in register.ts.
import { entryBlock } from './record'

// The longest search term, in characters: it is one argument of a host command, and a longer one is not a detail to look up.
export const SEARCH_TERM_CHARS = 200
// The matching lines a search shows; the rest are counted, so one search's answer stays small.
const MATCH_CAP = 10
// The characters a snippet keeps before its match and after it: a window around the match, since a line's opening is metadata.
const LEAD_CHARS = 100
const TAIL_CHARS = 100
// The characters of a line's digest a bounded read keeps: enough for a typical reply or tool result, small for the reviewer's context.
export const DIGEST_CHARS = 2000
// Page entries are runs of this many characters: at most 4 UTF-8 bytes each, so 10,000 fit a 50,000-byte page with the entry's header.
const CHUNK_CHARS = 10_000

// Prints each matching user or assistant line's number, the characters cut before and after its window and the window as a JSON string, then the count of matching lines in all. A line matches on the text digestOf reads from it, labels and tool calls included and metadata left out. The helpers mirror digestOf's pieces in this file; JSON::PP keeps no key order, so tool inputs are sorted here, as canonicalJson sorts them.
const SEARCH_SCRIPT = `use strict; use warnings;
use JSON::PP;
my ($file, $term) = @ARGV;
my $re = qr/\\Q$term\\E/i;
my $json = JSON::PP->new->allow_nonref;
my $canon = JSON::PP->new->allow_nonref->canonical;
open(my $fh, '<:encoding(UTF-8)', $file) or die "cannot open\\n";
binmode(STDOUT, ':encoding(UTF-8)');

sub text_of { my ($v) = @_; return defined $v && !ref $v ? $v : '' }
sub is_record { my ($v) = @_; return ref $v eq 'HASH' }
sub is_true { my ($v) = @_; return ref $v && JSON::PP::is_bool($v) && $v ? 1 : 0 }
sub user_label {
  my ($row) = @_;
  my $kind = is_record($row->{origin}) ? text_of($row->{origin}{kind}) : '';
  return 'PROMPT (unknown origin)' if $kind eq '';
  return grep({ $_ eq $kind } qw(human composer bridge sdk)) ? 'USER' : "PROMPT ($kind)";
}
sub result_text {
  my ($content) = @_;
  return text_of($content) unless ref $content eq 'ARRAY';
  return join("\\n", map { text_of($_->{text}) } grep { is_record($_) && text_of($_->{type}) eq 'text' } @$content);
}
sub pieces {
  my ($row) = @_;
  my $type = text_of($row->{type});
  return () unless $type eq 'user' || $type eq 'assistant';
  my $label = $type eq 'assistant' ? 'ASSISTANT' : user_label($row);
  my $content = is_record($row->{message}) ? $row->{message}{content} : undef;
  return ($label . ": $content") if defined $content && !ref $content;
  return () unless ref $content eq 'ARRAY';
  my @pieces;
  for my $block (grep { is_record($_) } @$content) {
    my $kind = text_of($block->{type});
    if ($kind eq 'text') { my $text = text_of($block->{text}); push @pieces, $label . ": $text" }
    elsif ($kind eq 'tool_use') { push @pieces, 'TOOL ' . text_of($block->{name}) . '(' . (exists $block->{input} ? $canon->encode($block->{input}) : '') . ')' }
    elsif ($kind eq 'tool_result') { push @pieces, 'TOOL RESULT' . (is_true($block->{is_error}) ? ' (ERROR)' : '') . ': ' . result_text($block->{content}) }
  }
  return @pieces;
}
my ($n, $total, $shown) = (0, 0, 0);
while (defined(my $line = <$fh>)) {
  $n++;
  chomp $line;
  next unless $line =~ /"type":"(?:user|assistant)"/;
  my $row = eval { $json->decode($line) };
  next unless is_record($row);
  my $digest = join("\\n", pieces($row));
  next if $digest eq '';
  next unless $digest =~ $re;
  $total++;
  next if $shown >= ${MATCH_CAP};
  $shown++;
  my ($at, $end) = ($-[0], $+[0]);
  my $from = $at > ${LEAD_CHARS} ? $at - ${LEAD_CHARS} : 0;
  my $to = $end + ${TAIL_CHARS} < length($digest) ? $end + ${TAIL_CHARS} : length($digest);
  print join("\\t", $n, $from, length($digest) - $to, $json->encode(substr($digest, $from, $to - $from))), "\\n";
}
print join("\\t", 'total', $total), "\\n";
`

// The term is one argument, never a regex or a shell word: perl quotes it with \Q, and no shell reads it.
// A lookup decodes every user and assistant line of a long transcript, which can outlast process.run's default 30 seconds.
export const LOOKUP_TIMEOUT_MS = 120_000

export const searchCommand = (file: string, term: string): string[] => ['perl', '-CA', '-e', SEARCH_SCRIPT, '--', file, term]

// sed quits after the line, so a long transcript is not read on past it. The `;` before `}` is for BSD sed (macOS), which rejects `{p;q}` with "extra characters at the end of q command".
export const lineCommand = (file: string, line: number): string[] => ['sed', '-n', `${line}{p;q;}`, file]

type Lookup = { kind: 'search'; term: string } | { kind: 'line'; line: number; full: boolean; from: number }

// The call's input as a lookup, or the refusal that says why it is not one.
export const lookupOf = (input: Record<string, unknown>): { lookup: Lookup } | { refusal: string } => {
  const { search, line, full, from } = input
  if (search !== undefined && line !== undefined) return { refusal: 'give search or line, not both' }
  if (search !== undefined) {
    if (typeof search !== 'string' || search === '') return { refusal: 'search must be a term of one or more characters' }
    // spawn cannot pass a NUL in an argument, so the term is refused before any process runs.
    if (search.includes('\0')) return { refusal: 'search must not contain a NUL character' }
    if (Array.from(search).length > SEARCH_TERM_CHARS) return { refusal: `search must be at most ${SEARCH_TERM_CHARS} characters` }
    if (full !== undefined || from !== undefined) return { refusal: 'full and from belong to a line lookup, not a search' }
    return { lookup: { kind: 'search', term: search } }
  }
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return { refusal: 'give search, a term to find, or line, a line number from 1' }
  if (full !== undefined && typeof full !== 'boolean') return { refusal: 'full must be true or false' }
  const page = from ?? 1
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) return { refusal: 'from must be a whole entry number, 1 or more' }
  if (from !== undefined && full !== true) return { refusal: 'from pages a whole line, so it needs full: true' }
  return { lookup: { kind: 'line', line, full: full === true, from: page } }
}

type Hit = { line: number; before: number; after: number; snippet: string }
type Found = { total: number; hits: Hit[] }

// One hit row's fields: its line number, the characters cut before and after its window, and the window as a JSON string. A row that does not read is null, which lookUp logs.
const hitOf = ([line, before, after, snippet]: string[]): Hit | null => {
  const hit = { line: Number(line), before: Number(before), after: Number(after) }
  if (![hit.line, hit.before, hit.after].every(Number.isInteger)) return null
  let text: unknown
  try {
    text = JSON.parse(snippet ?? '')
  } catch {
    return null
  }
  return typeof text === 'string' ? { ...hit, snippet: text } : null
}

// The search's output read back: its hits in order and its count of matching lines, or null when it has no count or a hit row does not read.
export const parseSearch = (stdout: string): Found | null => {
  const hits: Hit[] = []
  let total: number | undefined
  for (const row of stdout.split('\n')) {
    const fields = row.split('\t')
    if (fields[0] === 'total' && fields.length === 2) total = Number(fields[1])
    else if (fields.length === 4) {
      const hit = hitOf(fields)
      if (hit === null) return null
      hits.push(hit)
    }
  }
  if (total === undefined || !Number.isInteger(total)) return null
  return { total, hits }
}

// Each cut is named by its side, so a count before the snippet and one after it cannot be misread.
const hitLine = (h: Hit): string => `line ${h.line}: ${h.before > 0 ? `…+${h.before} characters before ` : ''}${h.snippet}${h.after > 0 ? ` …+${h.after} characters after` : ''}`

// The answer to a search: the count of matching lines, a note of the rest when more match than are shown, then each shown match.
export const renderSearch = (term: string, found: Found): string => {
  if (found.total === 0) return `No line of the session transcript matches "${term}".`
  const shown = found.hits.slice(0, MATCH_CAP)
  const count = found.total === 1 ? '1 line matches' : `${found.total} lines match`
  const note = found.total > shown.length ? `; the first ${shown.length} are shown` : ''
  return [`${count} "${term}"${note}:`, ...shown.map(hitLine)].join('\n')
}

const NO_TEXT = '(no text in this row)'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const textOf = (v: unknown): string => (typeof v === 'string' ? v : '')

// A JSON value with its object keys sorted at every depth: how a tool input reads in a digest and in the search alike.
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

// A tool result's text: its content as a string, or the text of its content blocks.
const resultText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(isRecord).filter(b => b['type'] === 'text').map(b => textOf(b['text'])).join('\n')
}

// The origin kinds whose text is the user's own words: register.ts's promptEntry set, plus human, the transcript's kind for a typed prompt.
const USER_KINDS = ['human', 'composer', 'bridge', 'sdk']

// A user row's label from its origin, as the record labels the same prompt; a row with no origin is unclassified, never the user's.
const userLabel = (row: Record<string, unknown>): string => {
  const kind = isRecord(row['origin']) ? textOf(row['origin']['kind']) : ''
  if (kind === '') return 'PROMPT (unknown origin)'
  return USER_KINDS.includes(kind) ? 'USER' : `PROMPT (${kind})`
}

// One row's pieces: a user's or assistant's text, a tool call's name and input, a tool result's text; thinking and metadata are not shown.
const piecesOf = (row: Record<string, unknown>): string[] => {
  if (row['type'] !== 'assistant' && row['type'] !== 'user') return []
  const label = row['type'] === 'assistant' ? 'ASSISTANT' : userLabel(row)
  const message: Record<string, unknown> = isRecord(row['message']) ? row['message'] : {}
  const content = message['content']
  if (typeof content === 'string') return [`${label}: ${content}`]
  if (!Array.isArray(content)) return []
  return content.filter(isRecord).flatMap(block => {
    if (block['type'] === 'text') return [`${label}: ${textOf(block['text'])}`]
    if (block['type'] === 'tool_use') return [`TOOL ${textOf(block['name'])}(${block['input'] === undefined ? '' : canonicalJson(block['input'])})`]
    if (block['type'] === 'tool_result') return [`TOOL RESULT${block['is_error'] === true ? ' (ERROR)' : ''}: ${resultText(block['content'])}`]
    return []
  })
}

// A transcript line's digest, or null when the line is not JSON, which the caller refuses.
export const digestOf = (raw: string): string | null => {
  let row: unknown
  try {
    row = JSON.parse(raw)
  } catch {
    return null
  }
  const pieces = isRecord(row) ? piecesOf(row) : []
  return pieces.length === 0 ? NO_TEXT : pieces.join('\n')
}

// A whole digest as page entries: its characters in runs of CHUNK_CHARS, each an entry block numbered from 1.
export const digestBlocks = (digest: string): string[] => {
  const chars = Array.from(digest)
  const blocks: string[] = []
  for (let i = 0; i < chars.length; i += CHUNK_CHARS) blocks.push(entryBlock(blocks.length + 1, chars.slice(i, i + CHUNK_CHARS).join('')))
  return blocks
}
