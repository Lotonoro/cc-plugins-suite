import { expect, test } from 'claude-code/testing'
import { STEERING, TOOL_NAME, TOOL_SPEC } from './steering'
import { TOOL } from './items'

test('the steering section is a session section that names the tool and its rules', () => {
  expect(STEERING.id).toBe('human-plugin:steering')
  expect(STEERING.scope).toBe('session')
  expect(STEERING.text).toContain('human_items')
  expect(STEERING.text).toContain('blocking')
  for (const rule of ['Never restate', 'no longer applies', 'said so in chat', 'resolved it yourself', 'check first', 'say why in one line', 'call list', 'A subagent removes only', 'markdown brief', 'one-line question first', 'do not repeat or sum up the brief', 'fold the explanation into its detail', 'never the explanation itself', 'Use AskUserQuestion for a question you need answered now', 'Never put the same ask in both', 'Use append to add to an item', 'the moment you would write it', 'a closing recap of open questions', 'A decision must be filed with options', 'a step of their own to take', 'Your own follow-up work']) {
    expect(STEERING.text).toContain(rule)
  }
  expect(STEERING.text).not.toContain('go with your recommendation')
})

test('the options a decision takes are in the schema, as AskUserQuestion takes them', () => {
  expect(TOOL_SPEC.inputSchema.properties.options.minItems).toBe(2)
  expect(TOOL_SPEC.inputSchema.properties.options.maxItems).toBe(4)
  expect(TOOL_SPEC.inputSchema.properties.options.items.required).toEqual(['label'])
  expect(TOOL_SPEC.description).toContain('options')
  expect(TOOL_SPEC.description).toContain('A decision must be filed with options')
})

test('the steering sentence asks the agent for option labels only, not descriptions', () => {
  expect(STEERING.text).toContain('2 to 4, each with a label, at most one recommended.')
  expect(STEERING.text).not.toContain('each with a label and a description')
})

test('the tool spec registers under the name the tool hook answers to', () => {
  expect(TOOL).toBe(`mcp__human-plugin__${TOOL_NAME}`)
  expect(TOOL_SPEC.name).toBe(TOOL_NAME)
  expect(TOOL_SPEC.inputSchema.required).toEqual(['action'])
  expect(TOOL_SPEC.inputSchema.properties.action.enum).toEqual(['add', 'update', 'append', 'remove', 'list'])
})

test('the tool description says which of the two a question is for, and that a question still open goes on the list, not in a recap', () => {
  expect(TOOL_SPEC.description).toContain('AskUserQuestion')
  expect(TOOL_SPEC.description).toContain('Never put the same ask in both.')
  expect(TOOL_SPEC.description).toContain('the moment you would write it, not in a closing recap')
})

test('the tool description and schema name append, the action that adds to a brief', () => {
  expect(TOOL_SPEC.description).toContain('append adds a section')
  expect(TOOL_SPEC.inputSchema.properties.text.type).toBe('string')
})

test('the schema has the yes/no marker beside options, a boolean', () => {
  expect(TOOL_SPEC.inputSchema.properties.yesno.type).toBe('boolean')
})

test('the steering sentence files a yes/no question with the marker, not as two options named Yes and No', () => {
  expect(STEERING.text).toContain('yesno: true')
  expect(STEERING.text).toContain('not as two options named Yes and No')
})

test('the steering sentence says a proposal waiting on the human\'s word is an ask, filed the moment it comes up', () => {
  expect(STEERING.text).toContain('"say go", "unless you veto", "your call" or "yes or no?"')
  expect(STEERING.text).toContain('the moment it comes up, not appended to a report')
})

test('the steering line says a ✓ that means more than "I did it" is filed with done, the label naming the press', () => {
  expect(STEERING.text).toContain("When pressing ✓ would mean anything other than 'I did it', such as approving a proposal or going with your recommendation, file it with `done`, the label naming what a press does (e.g. \"Go with sqlite\"), when there is no meaningful 'no'; otherwise use yesno.")
})

test('the tool schema takes done, a string, for a to-do\'s ✓', () => {
  expect(TOOL_SPEC.inputSchema.properties.done.type).toBe('string')
  expect(TOOL_SPEC.inputSchema.properties.done.description).toContain('Go with sqlite')
})

test('the steering line and the tool description keep one question to an item', () => {
  expect(STEERING.text).toContain('- One item asks one question: two questions are two items, each answered on its own.')
  expect(TOOL_SPEC.description).toContain('One item asks one question.')
})

test('the tool description says any change to a sent item reopens it, and a clear alone does not', () => {
  expect(TOOL_SPEC.description).toContain('Any change to a sent item (an append, or an update that sets something) reopens it for the human, so change a sent item only when the human has something more to read or answer, and otherwise remove it;')
  expect(TOOL_SPEC.description).toContain('clearing a field alone (a blank note, done or detail) does not reopen it.')
  expect(TOOL_SPEC.description).not.toContain('A note on a done item reopens it')
})

test('blocking means a workstream is blocked, and the agent promotes an item with update once a workstream waits on it', () => {
  expect(STEERING.text).toContain('Mark it blocking when any workstream cannot go on without the human; once a workstream has reached a point where it waits on a non-blocking item, mark that item blocking with update.')
  expect(TOOL_SPEC.inputSchema.properties.blocking.description).toBe('True when any workstream cannot go on without the human. Set it with update once a workstream has reached a point where it waits on a non-blocking item.')
  expect(STEERING.text).not.toContain('when the work cannot go on')
})

test('the done schema asks for a few words, at most 24 columns', () => {
  expect(TOOL_SPEC.inputSchema.properties.done.description).toContain('a few words, at most 24 columns')
})
