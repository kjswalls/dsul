/**
 * The rules a prep card follows, shared by the two writers: the person's own
 * model (/api/ai/prep's system prompt) and an agent handed the item to get
 * ready (MCP's dsul_prep_brief). One list, so OpenClaw and Claude are held to
 * exactly what the model is, and a rule changed here changes for both.
 */

/** Which card, and what goes in it. */
export const PREP_KIND_RULES: readonly string[] = [
  "Pick the kind the item asks for: writing to someone is an email or a message, phoning is a call, buying or packing several things is a list, longer writing that is not a message is a draft, a big or vague item is subtasks, anything else that is stuck for want of a start is steps.",
  "Subtasks: two to eight small, concrete pieces the item breaks into, each a row the person will tick off. Never repeat a subtask it already has. Use subtasks for an item too big to start, steps for one that only needs a first move.",
  "Time: only for an item that is not planned for a day yet and plainly needs a slot (an appointment to keep, a long job, something with a deadline). A time later than now, on today or a near day; \"duration\" in minutes, 5 to 480. Never for an errand that fits anywhere.",
  "Options, form answers, an answer, a place and a pick need facts from outside the list. Without them, use these kinds only when the notes already hold what they need (the choices, the form's questions, the fact itself).",
  "Never invent an email address, a phone number, a name, a price, a date or a fact. Use only what the title and notes say. Leave \"to\" and \"number\" out when they are not given.",
  "Emails and messages: short, warm, plain, ready to send as they are. No placeholders in brackets. No sign-off name.",
  "Call scripts: two to six short lines, in the order they would be said.",
  "Steps: two to five concrete actions; the first one takes under five minutes. Build on subtasks that are already there rather than repeating them.",
];

/** How it is written, and when to leave an item alone. */
export const PREP_TONE_RULES: readonly string[] = [
  "An item marked stuck keeps being moved to another day: something about starting it is hard. Make it smaller rather than better. Prefer steps whose first one takes under two minutes and needs no decision (open the thing, find the number, write one line), or the one question that is stopping it. Never mention that it moved, never say \"finally\" or \"still\".",
  "Use the planned day and today's date to get the timing right (\"by Friday\", \"this week\"), never to scold. Never call anything late or overdue.",
  "Write the way a kind friend would: plain words, no exclamation marks, no pep talk, no guilt.",
  "Skip any item a draft would not genuinely help (an errand, a chore, something already small). Skipping is fine.",
];

/** The model's question card. An agent asks with dsul_ask_user instead. */
export const PREP_QUESTION_RULE_LIST: readonly string[] = [
  "Question: when one missing fact is all that stands between the item and a real draft (who to write to, which day, what it is about), ask it instead of guessing. One short, plain question; \"options\" is two to four likely answers of a few words, or left out when you cannot guess any. Never ask what the notes already answer, and never ask more than one.",
];
