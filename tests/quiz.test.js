const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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
  for (let i = 0; i < quiz.questions.length; i++) {
    const item = byQuestion.get(quiz.get("question").textContent);
    const selected = i < correctCount ? item.correct : (item.correct + 1) % item.answers.length;
    quiz.get("answers").children[selected].click();
    quiz.get("next").click();
  }
}

test("each attempt has a fixed shuffled order with intact answers, feedback, and scoring", () => {
  const quiz = createQuiz();
  const byQuestion = new Map(quiz.questions.map((item) => [item.question, item]));
  const initialCalls = quiz.randomCalls();
  assert.ok(initialCalls > 0);

  function completeAttempt(correctCount) {
    const seen = [];
    for (let i = 0; i < quiz.questions.length; i++) {
      const question = quiz.get("question").textContent;
      const item = byQuestion.get(question);
      assert.ok(item);
      seen.push(question);
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
      assert.equal(quiz.get("progress-fill").style.width, `${(i + 1) / quiz.questions.length * 100}%`);
      quiz.get("next").click();
    }
    assert.equal(new Set(seen).size, quiz.questions.length);
    assert.equal(quiz.get("correct-total").textContent, `${correctCount} of ${quiz.questions.length}`);
    assert.equal(quiz.get("accuracy").textContent, `${correctCount / quiz.questions.length * 100}%`);
    return seen;
  }

  const firstOrder = completeAttempt(5);
  assert.equal(quiz.randomCalls(), initialCalls);
  assert.notDeepEqual(firstOrder, quiz.questions.map((item) => item.question));

  quiz.setRandom(0.999999);
  quiz.get("restart").click();
  assert.ok(quiz.randomCalls() > initialCalls);
  assert.equal(quiz.get("score").textContent, "0 points");
  assert.equal(quiz.get("progress").attributes["aria-valuenow"], "0");
  const secondCalls = quiz.randomCalls();
  const secondOrder = completeAttempt(10);
  assert.equal(quiz.randomCalls(), secondCalls);
  assert.notDeepEqual(secondOrder, firstOrder);
  assert.deepEqual(secondOrder, quiz.questions.map((item) => item.question));

  quiz.get("restart").click();
  assert.deepEqual(completeAttempt(0), secondOrder);
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
