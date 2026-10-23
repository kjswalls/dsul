/**
 * The rules a prep card follows, shared by the two writers: the person's own
 * model (/api/ai/prep's system prompt) and an agent handed the item to get
 * ready (MCP's dsul_prep_brief). One list, so OpenClaw and Claude are held to
 * exactly what the model is, and a rule changed here changes for both.
 */

/**
 * What the item means, decided before anything is written (Kirby's pick C,
 * 2026-10-23): a guess the person can't see wastes the whole card. Sure is
 * written as before; fairly sure is written with its reading on top, which the
 * card's "Not quite?" corrects; unsure or big asks first.
 */
export const PREP_MEANING_RULES: readonly string[] = [
  "Before you write anything for an item, decide what it means: what is wanted, and who or what each name in it is.",
  "Sure (only one sensible reading): write the card as below.",
  "Fairly sure (one reading is likely but another is plausible): write the card for the likely one, and add \"reading\": one short line on what you took it to mean, in the person's terms (\"text Sammy to sort out your license\"), and \"alternates\": up to three other likely meanings, a few words each (\"Sammy's a pet: get a pet license\"). Keep that card small: the first move, never a whole plan built on the guess.",
  "Unsure (you cannot tell what is wanted, or who or what a name is) or big and open (a trip, a move, an event to plan, with nothing settled in the notes): ask before you write, never guess.",
  "Write an email or a message only when the item is about contacting someone. A name in the title is not enough: \"get sammy's license\" is not a message to Sammy, and Sammy may not be a person.",
];

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
  "Question: when you are unsure what an item means, or one missing fact stands between it and a real card (who it is for, which day, what it is about), ask instead of guessing. Ask as few as will do, one if one is enough: \"question\" is the first, and \"more\" holds at most two others. Each is short and plain, with \"options\": two to four likely answers of a few words, left out when you cannot guess any.",
  "For a big, open item, ask what is settled already, with \"multi\": true so several answers can be picked: \"What's settled already?\" with options like \"Dates\", \"Cities\", \"Who's going\", \"Budget\". The card after it then covers only what is left.",
  "Never ask what the notes already answer. Lines in the notes like \"Who's Sammy? My dog\" or \"I meant: …\" are the person's own answers: trust them over the title.",
];
