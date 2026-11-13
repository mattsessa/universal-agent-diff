# Try Universal Agent Diff

Each test below has two parts: what you do, and an instruction for your agent.
To run a test, prompt your agent: "Do test N in TEST_ME.md."

To start over, discard your changes to this file in source control.

> Agent: only do the test (or part) you were asked to do. Edit this file directly; don't ask for confirmation.

---

## Test 1: Accept / Reject, and changes pile up

### Part A

You: prompt your agent "Do test 1A in TEST_ME.md." Don't accept or reject anything yet.

Agent: replace the line below with `Status: changed by the agent`.

Status: not done

### Part B

You: with Part A's change still pending, prompt your agent "Do test 1B in TEST_ME.md." Then accept or reject each change.

Agent: add one line at the end of the list below: `- line added by the agent`.

- first line

---

## Test 2: Your edits join an open review

You: prompt your agent "Do test 2 in TEST_ME.md." While its change is still pending, type anything on the line below and save.

Agent: change `apple` to `banana` on the line below.

Fruit: apple

---

## Test 3: Unsaved edits when the agent writes

You: type something on the line below but don't save. Then prompt your agent "Do test 3 in TEST_ME.md." Then either save and choose Overwrite, or close the tab and choose Don't Save.

Agent: change `one` to `two` on the line below.

Number: one

---

## Test 4: New files

You: prompt your agent "Do test 4 in TEST_ME.md."

Agent: create a file named `scratch.txt` next to this one, containing `hello`.

---

## Test 5: Deleted files

You: if you deleted `scratch.txt` in test 4, run test 4 again and Accept. Then prompt your agent "Do test 5 in TEST_ME.md."

Agent: delete `scratch.txt`.

---

## Also try

- Side panel: the Universal Agent Diff icon lists every file with pending changes. Hover a file for Accept all / Reject all.
- Command Palette: Next Pending Change / Previous Pending Change.
- Restart VS Code with a change pending: it's still there.
- Debug log: Command Palette → Developer: Set Log Level… → Universal Agent Diff → Debug, then rerun any test and open Output → Universal Agent Diff. Each change is logged with its file path and what the extension decided, never file contents.
