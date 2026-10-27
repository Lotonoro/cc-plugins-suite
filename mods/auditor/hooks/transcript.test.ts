import { describe, expect, test } from 'claude-code/testing'
import { digestBlocks, digestOf, lineCommand, lookupOf, parseSearch, renderSearch, searchCommand } from './transcript'

describe('searchCommand', () => {
  test('the term reaches perl as its own argument, matched as quoted text, and no shell runs', () => {
    const argv = searchCommand('/t.jsonl', 'a.*(b)')
    expect(argv.slice(-2)).toEqual(['/t.jsonl', 'a.*(b)'])
    expect(argv[0]).toBe('perl')
    expect(argv).not.toContain('sh')
    expect(argv[3]).toContain('my $re = qr/\\Q$term\\E/i;')
  })

  test('the script prints the window of the digest around the match, as a JSON string, never the whole digest', () => {
    expect(searchCommand('/t.jsonl', 'x')[3]).toContain('print join("\\t", $n, $from, length($digest) - $to, $json->encode(substr($digest, $from, $to - $from))), "\\n";')
  })

  test('the script bounds the window at 100 characters either side of the match', () => {
    const script = searchCommand('/t.jsonl', 'x')[3] ?? ''
    expect(script).toContain('my $from = $at > 100 ? $at - 100 : 0;')
    expect(script).toContain('my $to = $end + 100 < length($digest) ? $end + 100 : length($digest);')
  })

  test('the script skips rows that carry no text before they count or take one of the ten shown', () => {
    const script = searchCommand('/t.jsonl', 'x')[3] ?? ''
    const typed = script.indexOf('next unless $line =~ /"type":"(?:user|assistant)"/;')
    expect(typed).toBeGreaterThan(-1)
    expect(typed).toBeLessThan(script.indexOf('next unless $digest =~ $re;'))
    expect(typed).toBeLessThan(script.indexOf('$total++;'))
  })

  test('the script stops showing at the cap, and counts every matching line', () => {
    const script = searchCommand('/t.jsonl', 'x')[3] ?? ''
    expect(script).toContain('next if $shown >= 10;')
    expect(script).toContain('$total++;')
  })
})

describe('the search matches the text a digest reads', () => {
  test('the script decodes each line and matches on the pieces digestOf joins, never on the raw line', () => {
    const script = searchCommand('/t.jsonl', 'x')[3] ?? ''
    expect(script).toContain('use JSON::PP;')
    expect(script).toContain('my $digest = join("\\n", pieces($row));')
    expect(script).not.toContain('next unless $line =~ $re;')
  })

  test('a tool input is sorted by key in the search, as the digest shows it', () => {
    expect(searchCommand('/t.jsonl', 'x')[3]).toContain('my $canon = JSON::PP->new->allow_nonref->canonical;')
  })
})

describe('lineCommand', () => {
  test('sed prints the line and quits, so it does not read the transcript on past it, in a form BSD sed accepts too', () => {
    expect(lineCommand('/t.jsonl', 4)).toEqual(['sed', '-n', '4{p;q;}', '/t.jsonl'])
  })
})

describe('lookupOf', () => {
  test('a search needs a term of one to 200 characters, and no line or page', () => {
    expect(lookupOf({ search: 'a', line: 1 })).toEqual({ refusal: 'give search or line, not both' })
    expect(lookupOf({})).toEqual({ refusal: 'give search, a term to find, or line, a line number from 1' })
    expect(lookupOf({ search: '' })).toEqual({ refusal: 'search must be a term of one or more characters' })
    expect(lookupOf({ search: 'x'.repeat(201) })).toEqual({ refusal: 'search must be at most 200 characters' })
    expect(lookupOf({ search: 'x'.repeat(200) })).toEqual({ lookup: { kind: 'search', term: 'x'.repeat(200) } })
    expect(lookupOf({ search: 'x', full: true })).toEqual({ refusal: 'full and from belong to a line lookup, not a search' })
  })

  test('a search term with a NUL is refused, since no process can take it as an argument', () => {
    expect(lookupOf({ search: 'a\0b' })).toEqual({ refusal: 'search must not contain a NUL character' })
  })

  test('a line lookup is the bounded digest of page 1 unless full is true', () => {
    expect(lookupOf({ line: 4 })).toEqual({ lookup: { kind: 'line', line: 4, full: false, from: 1 } })
    expect(lookupOf({ line: 4, full: true, from: 2 })).toEqual({ lookup: { kind: 'line', line: 4, full: true, from: 2 } })
  })

  test('a page needs full, a page is a whole number from 1, and full is true or false', () => {
    expect(lookupOf({ line: 4, from: 2 })).toEqual({ refusal: 'from pages a whole line, so it needs full: true' })
    expect(lookupOf({ line: 4, full: true, from: 0 })).toEqual({ refusal: 'from must be a whole entry number, 1 or more' })
    expect(lookupOf({ line: 4, full: 'yes' })).toEqual({ refusal: 'full must be true or false' })
    expect(lookupOf({ line: 0 })).toEqual({ refusal: 'give search, a term to find, or line, a line number from 1' })
    expect(lookupOf({ line: 1.5 })).toEqual({ refusal: 'give search, a term to find, or line, a line number from 1' })
  })
})

describe('parseSearch and renderSearch', () => {
  test('a snippet is read from its JSON string, so a tab or a newline in it reads back whole, and the count row is the last one read', () => {
    expect(parseSearch('3\t5\t6\t"a\\tb\\nc"\ntotal\t1\n')).toEqual({ total: 1, hits: [{ line: 3, before: 5, after: 6, snippet: 'a\tb\nc' }] })
  })

  test('the output a quoted term draws reads back as the text its line shows', () => {
    expect(parseSearch('1\t0\t0\t"USER: Please say \\"hi\\" to the parser."\ntotal\t1\n')).toEqual({ total: 1, hits: [{ line: 1, before: 0, after: 0, snippet: 'USER: Please say "hi" to the parser.' }] })
  })

  test('a hit whose snippet is not a JSON string is not a search result', () => {
    expect(parseSearch('3\t5\t6\tsnip\ntotal\t1\n')).toBeNull()
    expect(parseSearch('3\t5\t6\t42\ntotal\t1\n')).toBeNull()
  })

  test('output with no count is not a search result', () => {
    expect(parseSearch('3\t5\t6\tsnip\n')).toBeNull()
  })

  test('no match says so, and one match reads as one line, with no marker where nothing was cut', () => {
    expect(renderSearch('zz', { total: 0, hits: [] })).toBe('No line of the session transcript matches "zz".')
    expect(renderSearch('x', { total: 1, hits: [{ line: 2, before: 0, after: 0, snippet: 'x' }] })).toBe('1 line matches "x":\nline 2: x')
  })

  test('a cut is named by its side: the count before the snippet, or the count after it', () => {
    expect(renderSearch('x', { total: 1, hits: [{ line: 2, before: 5, after: 0, snippet: 'x' }] })).toBe('1 line matches "x":\nline 2: …+5 characters before x')
    expect(renderSearch('x', { total: 1, hits: [{ line: 2, before: 0, after: 7, snippet: 'x' }] })).toBe('1 line matches "x":\nline 2: x …+7 characters after')
  })
})

describe('digestOf', () => {
  test('a prompt the user typed is USER, and an assistant text and a tool call, and a tool result each carry their label', () => {
    expect(digestOf(JSON.stringify({ type: 'user', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: 'fix it' } }))).toBe('USER: fix it')
    expect(digestOf(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'on it' }, { type: 'tool_use', name: 'Edit', input: { file_path: 'p.ts' } }] } })))
      .toBe('ASSISTANT: on it\nTOOL Edit({"file_path":"p.ts"})')
    expect(digestOf(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'edited' }] } }))).toBe('TOOL RESULT: edited')
    expect(digestOf(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'no such file' }] }] } }))).toBe('TOOL RESULT (ERROR): no such file')
  })

  test('a tool input reads with its keys sorted at every depth, the one spelling the search reads too', () => {
    const input = { old_string: 'a', file_path: 'p.ts', opts: { z: 1, a: [{ y: 2, x: 3 }] } }
    expect(digestOf(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input }] } })))
      .toBe('TOOL Edit({"file_path":"p.ts","old_string":"a","opts":{"a":[{"x":3,"y":2}],"z":1}})')
  })

  test('a tool result row, shaped as the engine writes it, is a TOOL RESULT and never USER', () => {
    const row = { type: 'user', sourceToolAssistantUUID: 'a1', toolUseResult: { type: 'text' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '1\t# Coding Principles' }] } }
    expect(digestOf(JSON.stringify(row))).toBe('TOOL RESULT: 1\t# Coding Principles')
  })

  test('the plugin\'s submitted note is PROMPT (plugin), not USER', () => {
    const row = { type: 'user', origin: { kind: 'plugin', name: 'auditor' }, promptSource: 'system', message: { role: 'user', content: 'The auditor plugin sent a message:\nauditor, review 1:\nThe conventions say to read the testing guard rules.' } }
    expect(digestOf(JSON.stringify(row))).toBe('PROMPT (plugin): The auditor plugin sent a message:\nauditor, review 1:\nThe conventions say to read the testing guard rules.')
  })

  test('another session\'s message is PROMPT (peer), not USER', () => {
    const row = { type: 'user', isMeta: true, origin: { kind: 'peer', from: 'auditor-reviewer', name: 'auditor-reviewer', handback: true }, promptSource: 'system', message: { role: 'user', content: 'Another Claude session sent a message:\n<agent-message from="auditor-reviewer">\n[Subagent hand-back] The report follows.' } }
    expect(digestOf(JSON.stringify(row))).toBe('PROMPT (peer): Another Claude session sent a message:\n<agent-message from="auditor-reviewer">\n[Subagent hand-back] The report follows.')
  })

  test('a task notification is PROMPT (task-notification), not USER', () => {
    const row = { type: 'user', origin: { kind: 'task-notification', producer: 'session-task', runId: '0mvi9eu9d-4f09ba3d' }, promptSource: 'system', message: { role: 'user', content: '<task-notification>\n<task-id>a4c46e195360a6c37</task-id>\n<status>completed</status>\n<summary>Agent "auditor review" finished</summary>' } }
    expect(digestOf(JSON.stringify(row))).toBe('PROMPT (task-notification): <task-notification>\n<task-id>a4c46e195360a6c37</task-id>\n<status>completed</status>\n<summary>Agent "auditor review" finished</summary>')
  })

  test('the coordinator\'s message is PROMPT (coordinator), not USER', () => {
    const row = { type: 'user', isMeta: true, origin: { kind: 'coordinator' }, promptSource: 'system', message: { role: 'user', content: 'The coordinator sent a message while you were working:\nRe-validation request.' } }
    expect(digestOf(JSON.stringify(row))).toBe('PROMPT (coordinator): The coordinator sent a message while you were working:\nRe-validation request.')
  })

  test('an interrupt marker, which has no origin, is PROMPT (unknown origin), not USER', () => {
    const row = { type: 'user', interruptedMessageId: 'm1', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }
    expect(digestOf(JSON.stringify(row))).toBe('PROMPT (unknown origin): [Request interrupted by user]')
  })

  test('a system-injected row with no origin is PROMPT (unknown origin), not USER', () => {
    const row = { type: 'user', isMeta: true, message: { role: 'user', content: '<system-reminder>\nYour final report is delivered through SubagentHandback.\n</system-reminder>' } }
    expect(digestOf(JSON.stringify(row))).toBe('PROMPT (unknown origin): <system-reminder>\nYour final report is delivered through SubagentHandback.\n</system-reminder>')
  })

  test('a row with no text says so, and a line that is not JSON has no digest', () => {
    expect(digestOf(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hidden' }] } }))).toBe('(no text in this row)')
    expect(digestOf('not json')).toBeNull()
  })
})

describe('digestBlocks', () => {
  test('a digest is cut into entries of 10,000 characters, a surrogate pair never split', () => {
    const blocks = digestBlocks('😀'.repeat(10001))
    expect(blocks).toEqual([`[1] ${'😀'.repeat(10000)}\n\n`, '[2] 😀\n\n'])
  })
})
