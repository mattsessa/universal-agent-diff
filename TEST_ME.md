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

## Test 6: Env files are always reviewed

Env files (`.env`, `.env.*`, `*.env`, `.envrc`) are reviewed even when `.gitignore` ignores them.

### Part A

You: prompt your agent "Do test 6A in TEST_ME.md." Accept the new file.

Agent: create a file named `.env.sandbox` next to this one, containing `API_URL=https://sandbox.example.com`.

### Part B

You: prompt your agent "Do test 6B in TEST_ME.md." Only the changed line should be under review, not the whole file. Reject it: `sandbox` comes back. Delete `.env.sandbox` when you're done.

Agent: in `.env.sandbox` next to this file, change `sandbox` to `staging`.

---

## Test 7: Replacing one of two identical lines

You: prompt your agent "Do test 7 in TEST_ME.md." You should see one change: the old line in red directly above the new green line, with one Accept / Reject. Not a green line with a separate red line below it.

Agent: the two lines below are identical. Replace only the first one with `Repeated line, replaced by the agent.`

Repeated line.
Repeated line.

---

## Test 8: Your renames aren't reviewed

Renaming or moving a file in VS Code is your change, not the agent's.

### Part A

You: prompt your agent "Do test 8A in TEST_ME.md." Accept the new file. Then rename it to `renamed.txt` in the Explorer: nothing shows up for review.

Agent: create a file named `rename-me.txt` next to this one, containing `hello`.

### Part B

You: prompt your agent "Do test 8B in TEST_ME.md." Don't accept it. Rename the file back to `rename-me.txt` in the Explorer: the pending change moves with it. Reject it, then delete the file.

Agent: in `renamed.txt` next to this file, change `hello` to `goodbye`.

---

## Also try

- Side panel: the Universal Agent Diff icon lists every file with pending changes. Hover a file for Accept all / Reject all.
- Command Palette: Next Pending Change / Previous Pending Change.
- Restart VS Code with a change pending: it's still there.
- Rename or drag a folder in the Explorer: nothing in it shows up for review (open a file in it afterwards to check), and pending changes inside move with it.
- Multi-root workspace: File → Add Folder to Workspace… with a second Git repo, then have your agent change a file in each repo. Both show up in the side panel, labeled with their repo.
- Nested repo: open a folder that contains another Git repo inside it, and have your agent change a file in the inner repo. It shows up labeled with the inner repo's name.
- Debug log: Command Palette → Developer: Set Log Level… → Universal Agent Diff → Debug, then rerun any test and open Output → Universal Agent Diff. Each change is logged with its file path and what the extension decided, never file contents.
