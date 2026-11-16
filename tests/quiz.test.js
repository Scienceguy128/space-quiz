const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const attemptSize = 10;

test("category labels meet normal-text contrast requirements in both themes", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const light = html.match(/:root\s*\{([^}]+)\}/);
  const dark = html.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]+)\}/);
  const category = html.match(/\.category\s*\{([^}]+)\}/);
  assert.ok(light && dark && category, "theme and category rules must exist");
  assert.match(category[1], /(?:^|;)\s*color:\s*var\(--category-text\)/);
  assert.match(category[1], /(?:^|;)\s*background:\s*var\(--soft\)/);

  function luminance(hex) {
    const channels = hex.match(/[0-9a-f]{2}/gi).map((part) => {
      const value = parseInt(part, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  for (const [theme, rule] of [["light", light[1]], ["dark", dark[1]]]) {
    const foreground = rule.match(/--category-text:\s*#([0-9a-f]{6})\b/i);
    const background = rule.match(/--soft:\s*#([0-9a-f]{6})\b/i);
    assert.ok(foreground && background, `${theme} category colors must be defined`);
    const values = [luminance(foreground[1]), luminance(background[1])].sort((a, b) => b - a);
    const contrast = (values[0] + 0.05) / (values[1] + 0.05);
    assert.ok(contrast >= 4.5, `${theme} category contrast is ${contrast.toFixed(2)}:1`);
  }
});

class Element {
  constructor() {
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.listeners = {};
    this.classList = {
      add() {},
      remove() {},
      toggle() {}
    };
  }

  set textContent(value) {
    this.text = value;
    this.children = [];
  }

  get textContent() {
    return (this.text || "") + this.children.map((child) => child.textContent).join("");
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ""; this.children = children; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  click() { if (!this.disabled && this.listeners.click) return this.listeners.click(); }
}

function createQuiz(clipboard) {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement() { return new Element(); },
    createTextNode(text) { const node = new Element(); node.textContent = text; return node; }
  };
  let randomValue = 0;
  let randomCalls = 0;
  const math = Object.create(Math);
  math.random = () => { randomCalls++; return randomValue; };
  const context = vm.createContext({
    document,
    Math: math,
    navigator: clipboard === undefined ? {} : { clipboard }
  });
  vm.runInContext(script, context);
  return {
    get: (id) => document.getElementById(id),
    questions: JSON.parse(vm.runInContext("JSON.stringify(questions)", context)),
    setRandom: (value) => { randomValue = value; },
    randomCalls: () => randomCalls
  };
}

async function finishAttempt(quiz, correctCount) {
  const byQuestion = new Map(quiz.questions.map((item) => [item.question, item]));
  for (let i = 0; i < attemptSize; i++) {
    const item = byQuestion.get(quiz.get("question").textContent);
    const selected = i < correctCount ? item.correct : (item.correct + 1) % item.answers.length;
    quiz.get("answers").children[selected].click();
    quiz.get("next").click();
  }
}

test("the question pool has 20 distinct, complete questions", () => {
  const { questions } = createQuiz();
  assert.equal(questions.length, 20);
  assert.equal(new Set(questions.map((item) => item.question)).size, 20);
  for (const item of questions) {
    assert.ok(item.category && item.question && item.fact);
    assert.equal(item.answers.length, 4);
    assert.equal(new Set(item.answers).size, 4);
    assert.ok(item.answers.every((answer) => typeof answer === "string" && answer.length > 0));
    assert.ok(Number.isInteger(item.correct) && item.correct >= 0 && item.correct < 4);
  }
});

test("each attempt selects 10 unique questions with intact answers, feedback, and scoring", () => {
  const quiz = createQuiz();
  const byQuestion = new Map(quiz.questions.map((item) => [item.question, item]));
  const initialCalls = quiz.randomCalls();
  assert.ok(initialCalls > 0);

  function completeAttempt(correctCount) {
    const seen = [];
    for (let i = 0; i < attemptSize; i++) {
      const question = quiz.get("question").textContent;
      const item = byQuestion.get(question);
      assert.ok(item);
      seen.push(question);
      assert.equal(quiz.get("question-count").innerHTML, `Question ${String(i + 1).padStart(2, "0")} <span>/ 10</span>`);
      assert.equal(quiz.get("next-label").textContent, i === attemptSize - 1 ? "See my results" : "Next question");
      assert.equal(quiz.get("category").textContent, item.category);
      assert.deepEqual(quiz.get("answers").children.map((button) => button.children[1].textContent), item.answers);
      assert.equal(quiz.get("next").disabled, true);
      const selected = i < correctCount ? item.correct : (item.correct + 1) % item.answers.length;
      quiz.get("answers").children[selected].click();
      assert.equal(quiz.get("question").textContent, question);
      assert.ok(quiz.get("feedback").textContent.includes(item.fact));
      assert.ok(quiz.get("feedback").textContent.includes(
        i < correctCount ? "Stellar work!" : `The answer is ${item.answers[item.correct]}.`
      ));
      assert.equal(quiz.get("score").textContent, `${Math.min(i + 1, correctCount)} ${Math.min(i + 1, correctCount) === 1 ? "point" : "points"}`);
      assert.equal(quiz.get("progress").attributes["aria-valuenow"], String(i + 1));
      assert.equal(quiz.get("progress-fill").style.width, `${(i + 1) / attemptSize * 100}%`);
      quiz.get("next").click();
    }
    assert.equal(new Set(seen).size, attemptSize);
    assert.equal(quiz.get("result-score").innerHTML, `${correctCount} <span>/ 10</span>`);
    assert.equal(quiz.get("correct-total").textContent, `${correctCount} of 10`);
    assert.equal(quiz.get("accuracy").textContent, `${correctCount / attemptSize * 100}%`);
    return seen;
  }

  const firstOrder = completeAttempt(5);
  assert.equal(quiz.randomCalls(), initialCalls);
  assert.deepEqual(firstOrder, quiz.questions.slice(1, attemptSize + 1).map((item) => item.question));

  quiz.setRandom(0.999999);
  quiz.get("restart").click();
  assert.ok(quiz.randomCalls() > initialCalls);
  assert.equal(quiz.get("score").textContent, "0 points");
  assert.equal(quiz.get("progress").attributes["aria-valuenow"], "0");
  const secondCalls = quiz.randomCalls();
  const secondOrder = completeAttempt(10);
  assert.equal(quiz.randomCalls(), secondCalls);
  assert.notDeepEqual(secondOrder, firstOrder);
  assert.deepEqual(secondOrder, quiz.questions.slice(0, attemptSize).map((item) => item.question));
  assert.notDeepEqual(new Set(secondOrder), new Set(firstOrder));

  quiz.get("restart").click();
  assert.deepEqual(completeAttempt(0), secondOrder);
});

test("results review missed answers and a new perfect attempt clears the review", () => {
  const quiz = createQuiz();
  const byQuestion = new Map(quiz.questions.map((item) => [item.question, item]));

  for (let i = 0; i < attemptSize; i++) {
    const item = byQuestion.get(quiz.get("question").textContent);
    const selected = i < 2 ? (item.correct + 1) % item.answers.length : item.correct;
    quiz.get("answers").children[selected].click();
    quiz.get("next").click();
  }

  const review = quiz.get("missed-questions");
  assert.equal(review.children.length, 2);
  assert.equal(review.hidden, false);
  for (let i = 0; i < review.children.length; i++) {
    const item = byQuestion.get(review.children[i].children[0].textContent);
    assert.ok(item);
    assert.ok(review.children[i].textContent.includes(`Your answer: ${item.answers[(item.correct + 1) % item.answers.length]}`));
    assert.ok(review.children[i].textContent.includes(`Correct answer: ${item.answers[item.correct]}`));
    assert.ok(review.children[i].textContent.includes(`Explanation: ${item.fact}`));
  }
  assert.equal(quiz.get("no-missed-questions").hidden, true);

  quiz.get("restart").click();
  assert.equal(review.children.length, 0);

  for (let i = 0; i < attemptSize; i++) {
    const item = byQuestion.get(quiz.get("question").textContent);
    quiz.get("answers").children[item.correct].click();
    quiz.get("next").click();
  }

  assert.equal(review.children.length, 0);
  assert.equal(review.hidden, true);
  assert.equal(quiz.get("no-missed-questions").hidden, false);
  assert.ok(quiz.get("no-missed-questions").textContent.includes("there are no missed questions to review"));
});

test("copy result writes the current score and confirms success", async () => {
  const copied = [];
  const quiz = createQuiz({ writeText: async (text) => copied.push(text) });
  await finishAttempt(quiz, 3);

  await quiz.get("copy-result").click();
  assert.deepEqual(copied, ["I scored 3 out of 10 on the Space Exploration Quiz!"]);
  assert.equal(quiz.get("copy-status").textContent, "Result copied to clipboard.");
  assert.equal(quiz.get("copy-fallback").hidden, true);

  quiz.get("restart").click();
  await finishAttempt(quiz, 8);
  await quiz.get("copy-result").click();
  assert.deepEqual(copied, [
    "I scored 3 out of 10 on the Space Exploration Quiz!",
    "I scored 8 out of 10 on the Space Exploration Quiz!"
  ]);
});

test("copy result provides selectable text when clipboard access is unavailable or denied", async () => {
  const clipboardOptions = [
    undefined,
    { writeText: async () => { throw new Error("Permission denied"); } }
  ];

  for (const clipboard of clipboardOptions) {
    const quiz = createQuiz(clipboard);
    await finishAttempt(quiz, 2);
    await quiz.get("copy-result").click();

    assert.match(quiz.get("copy-status").textContent, /copy it manually/);
    assert.equal(quiz.get("copy-fallback").value, "I scored 2 out of 10 on the Space Exploration Quiz!");
    assert.equal(quiz.get("copy-fallback").hidden, false);
    assert.equal(quiz.get("copy-fallback").selected, true);
  }
});
