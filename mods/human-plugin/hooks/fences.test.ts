import { expect, test } from 'claude-code/testing'
import { briefParts } from './fences'

test('a brief with no fenced code is one prose part', () => {
  expect(briefParts('Pick one.\n\nBoth work.')).toEqual([{ kind: 'prose', text: 'Pick one.\n\nBoth work.' }])
})

test('a fenced block is a code part between the prose around it, its body the lines inside the fences', () => {
  const brief = 'Run this:\n\n```sh\nls -la\ncd /tmp\n```\n\nThen say so.'
  expect(briefParts(brief)).toEqual([
    { kind: 'prose', text: 'Run this:' },
    { kind: 'code', text: '```sh\nls -la\ncd /tmp\n```', body: 'ls -la\ncd /tmp' },
    { kind: 'prose', text: 'Then say so.' },
  ])
})

test('a tilde fence and two blocks in a row each make a code part; a fence left open runs to the end', () => {
  expect(briefParts('~~~\na\n~~~\n```\nb\n```')).toEqual([
    { kind: 'code', text: '~~~\na\n~~~', body: 'a' },
    { kind: 'code', text: '```\nb\n```', body: 'b' },
  ])
  expect(briefParts('Try:\n```\nmake\nmake test')).toEqual([
    { kind: 'prose', text: 'Try:' },
    { kind: 'code', text: '```\nmake\nmake test', body: 'make\nmake test' },
  ])
})

test('a longer closing fence closes a block, and a shorter one is a line inside it', () => {
  expect(briefParts('````\n```\nx\n`````')).toEqual([{ kind: 'code', text: '````\n```\nx\n`````', body: '```\nx' }])
})

test('a table inside a backtick fence is drawn as written, inside its block', () => {
  const md = '```\n| a | b |\n|---|---|\n| 1 | 2 |\n```'
  expect(briefParts(md)).toEqual([{ kind: 'code', text: md, body: '| a | b |\n|---|---|\n| 1 | 2 |' }])
})

test('a tilde fence is closed only by a tilde, so a backtick line inside it does not end it, and a table after it is prose', () => {
  expect(briefParts('~~~\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n~~~\n| c | d |\n|---|---|\n| 3 | 4 |')).toEqual([
    { kind: 'code', text: '~~~\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n~~~', body: '```\n| a | b |\n|---|---|\n| 1 | 2 |' },
    { kind: 'prose', text: '| c | d |\n|---|---|\n| 3 | 4 |' },
  ])
})

test('a backtick run whose info string holds a backtick opens no fence', () => {
  const md = '```x```\n| a | b |\n|---|---|\n| 1 | 2 |'
  expect(briefParts(md)).toEqual([{ kind: 'prose', text: md }])
})

test('a top-level line indented four spaces that shows a fence is no fence: its lines stay prose', () => {
  const md = '    ```sh\n    ls\n    ```'
  expect(briefParts(md)).toEqual([{ kind: 'prose', text: md }])
})

test('a fence four or more columns past its list item\'s content column is no fence', () => {
  const md = '- a\n      ```sh\n      ls\n      ```'
  expect(briefParts(md)).toEqual([{ kind: 'prose', text: md }])
})

test('a fence inside a block quote is no fence: its lines stay prose', () => {
  const md = '> ```sh\n> ls\n> ```'
  expect(briefParts(md)).toEqual([{ kind: 'prose', text: md }])
})

test('a fence four or more columns in under a lazily wrapped item is no fence, and one three columns in is a top-level fence', () => {
  expect(briefParts('- a\nwrapped\n      ```sh\n      ls\n      ```')).toEqual([
    { kind: 'prose', text: '- a\nwrapped\n      ```sh\n      ls\n      ```' },
  ])
  expect(briefParts('- a\nwrapped\n   ```sh\n   ls\n   ```')).toEqual([
    { kind: 'prose', text: '- a\nwrapped' },
    { kind: 'code', text: '   ```sh\n   ls\n   ```', body: 'ls' },
  ])
})

test('a line indented less than its list item ends the item\'s fence, and the brief splits into four parts', () => {
  expect(briefParts('1. Run:\n   ```py\n   if x:\n       y()\n  z\n   ```')).toEqual([
    { kind: 'prose', text: '1. Run:' },
    { kind: 'code', text: '```py\nif x:\n    y()', body: 'if x:\n    y()' },
    { kind: 'prose', text: '  z' },
    { kind: 'code', text: '   ```', body: '' },
  ])
})

test('a blank line inside a list item\'s fence does not end it, and blank lines before the line that ends the item are in its copy', () => {
  expect(briefParts('1. Run:\n   ```\n   one\n\n   two\n\nNext.')).toEqual([
    { kind: 'prose', text: '1. Run:' },
    { kind: 'code', text: '```\none\n\ntwo\n', body: 'one\n\ntwo\n' },
    { kind: 'prose', text: 'Next.' },
  ])
})

test('a closing fence four or more columns past its item\'s content column does not close the block', () => {
  expect(briefParts('- a\n  ```\n  x\n      ```')).toEqual([
    { kind: 'prose', text: '- a' },
    { kind: 'code', text: '```\nx\n    ```', body: 'x\n    ```' },
  ])
})

test('a fence in a second-level item is drawn from its fence line, and copied without its item\'s indent', () => {
  expect(briefParts('- a\n  - b\n    ```sh\n    ls\n    ```')).toEqual([
    { kind: 'prose', text: '- a\n  - b' },
    { kind: 'code', text: '```sh\nls\n```', body: 'ls' },
  ])
})

test('a fence one column past its item keeps that column when drawn, and copies its body without it', () => {
  expect(briefParts('- a\n  - b\n     ```sh\n     ls\n     ```')).toEqual([
    { kind: 'prose', text: '- a\n  - b' },
    { kind: 'code', text: ' ```sh\n ls\n ```', body: 'ls' },
  ])
})

test('a fence on a list marker\'s own line keeps its marker, and the prose after its closing fence is prose', () => {
  expect(briefParts('- ```sh\n  ls\n  ```\nafter')).toEqual([
    { kind: 'code', text: '- ```sh\n  ls\n  ```', body: 'ls' },
    { kind: 'prose', text: 'after' },
  ])
})

test('a fence on a nested list marker\'s own line is drawn at its parent\'s column, and copies its body at the item\'s', () => {
  expect(briefParts('1. x\n   - ```sh\n     ls\n     ```\nafter')).toEqual([
    { kind: 'prose', text: '1. x' },
    { kind: 'code', text: '- ```sh\n  ls\n  ```', body: 'ls' },
    { kind: 'prose', text: 'after' },
  ])
})

test('a fence under a + item or a 1) item is recognised relative to that item', () => {
  expect(briefParts('+ a\n  1) b\n     ```sh\n     ls\n     ```')).toEqual([
    { kind: 'prose', text: '+ a\n  1) b' },
    { kind: 'code', text: '```sh\nls\n```', body: 'ls' },
  ])
})

test('a table whose rows sit inside a fence in a list item is drawn as written, inside its block', () => {
  expect(briefParts('- a\n  ```\n  | x | y |\n  |---|---|\n  | 1 | 2 |\n  ```')).toEqual([
    { kind: 'prose', text: '- a' },
    { kind: 'code', text: '```\n| x | y |\n|---|---|\n| 1 | 2 |\n```', body: '| x | y |\n|---|---|\n| 1 | 2 |' },
  ])
})

test('a body line indented with a tab under a fence two spaces in is copied with the tab\'s remaining columns as spaces', () => {
  expect(briefParts('  ```\n\tcode\n  ```')).toEqual([{ kind: 'code', text: '  ```\n\tcode\n  ```', body: '  code' }])
})

test('under an unindented fence a tab-indented body line is copied with its tab', () => {
  expect(briefParts('```\n\tcode\n```')).toEqual([{ kind: 'code', text: '```\n\tcode\n```', body: '\tcode' }])
})

test('whitespace past a cut stays as written, and a tab after the first non-whitespace character is copied unchanged', () => {
  expect(briefParts('  ```\n  \tcode\n  ```')).toEqual([{ kind: 'code', text: '  ```\n  \tcode\n  ```', body: '\tcode' }])
  expect(briefParts('```\na\tb\n```')).toEqual([{ kind: 'code', text: '```\na\tb\n```', body: 'a\tb' }])
})

test('a tab-indented body line in a nested fence is drawn with the indent its copy has', () => {
  expect(briefParts('- a\n  ```\n\tcode\n  ```')).toEqual([
    { kind: 'prose', text: '- a' },
    { kind: 'code', text: '```\n  code\n```', body: '  code' },
  ])
})

test('an item whose marker is followed by a tab takes the column the tab stop gives, and a fence at that column gets a code part', () => {
  expect(briefParts('-\tx\n    ```sh\n    ls\n    ```')).toEqual([
    { kind: 'prose', text: '-\tx' },
    { kind: 'code', text: '```sh\nls\n```', body: 'ls' },
  ])
})

test('a fence three spaces in, with a body line two spaces in, copies that line with no indent', () => {
  expect(briefParts('   ```\n  x\n   ```')).toEqual([{ kind: 'code', text: '   ```\n  x\n   ```', body: 'x' }])
})

test('the prose after a fence in a second-level item starts with no indent of four or more columns', () => {
  expect(briefParts('- a\n  - b\n    ```sh\n    ls\n    ```\n    after')).toEqual([
    { kind: 'prose', text: '- a\n  - b' },
    { kind: 'code', text: '```sh\nls\n```', body: 'ls' },
    { kind: 'prose', text: 'after' },
  ])
})

test('a bullet after a fence in a second-level item is at no more than three columns of indent', () => {
  expect(briefParts('- a\n  - b\n    ```sh\n    ls\n    ```\n    - c')).toEqual([
    { kind: 'prose', text: '- a\n  - b' },
    { kind: 'code', text: '```sh\nls\n```', body: 'ls' },
    { kind: 'prose', text: '- c' },
  ])
})

test('a table after a fence in a second-level item is prose with no indent of four or more columns', () => {
  expect(briefParts('- a\n  - b\n    ```sh\n    ls\n    ```\n    | x | y |\n    |---|---|\n    | 1 | 2 |')).toEqual([
    { kind: 'prose', text: '- a\n  - b' },
    { kind: 'code', text: '```sh\nls\n```', body: 'ls' },
    { kind: 'prose', text: '| x | y |\n|---|---|\n| 1 | 2 |' },
  ])
})

test('after a fence in item 1., a following item 2. keeps its indented sub-bullets, which stay nested under it', () => {
  expect(briefParts('1. Run:\n   ```sh\n   ls\n   ```\n2. Next:\n   - sub')).toEqual([
    { kind: 'prose', text: '1. Run:' },
    { kind: 'code', text: '```sh\nls\n```', body: 'ls' },
    { kind: 'prose', text: '2. Next:\n   - sub' },
  ])
})

test('a CRLF blank line does not end a list item, and CRLF line endings are kept as written', () => {
  expect(briefParts('1. Run:\r\n\r\n   ```sh\r\n   ls\r\n   ```')).toEqual([
    { kind: 'prose', text: '1. Run:\r' },
    { kind: 'code', text: '```sh\r\nls\r\n```', body: 'ls\r' },
  ])
})
