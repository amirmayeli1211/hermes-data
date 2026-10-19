/* story.js — narrative graph.
 *
 * SOURCES. The horror here is built on genuinely documented Persian folklore
 * rather than invented gore:
 *   - آل (Al): a figure in Iranian, Afghan and Central Asian folklore that preys
 *     on newborns and their mothers. Traditionally described as a woman with
 *     backwards-facing feet; the "backwards feet" and "counting" motifs recur
 *     across the region.
 *   - بختک (Bakhtak): the sleep-paralysis figure, a weight on the chest at night.
 *   - مردهخوار / جن: the corpse-eater and the jinn, both from the same tradition.
 * The house, the family and the events are fiction. The *folklore* is real, and
 * the notes cite which belief each detail comes from, so nothing here pretends a
 * fabricated event happened.
 *
 * Graph shape: nodes hold a speaker, lines, optional choices, and optional
 * `set`/`need`. Every node must terminate, `next`, or branch — the validator in
 * tools/validate-story.js enforces that.
 */
'use strict';

const STORY = {
  start: 'note_intro',
  nodes: {

    /* ================= HALL ================= */

    note_intro: {
      speaker: 'یادداشت',
      lines: [
        '«هر کس این را می‌خواند: از این خانه برو.»',
        '«این‌جا فقط یک اتاق عادی نیست. اتاق سیزدهم است.»',
        '«دو شب پیش صداهایی شنیدم که کسی حرف نمی‌زد — فقط نفس می‌کشید.»',
      ],
      set: { saw_intro: true },
      end: true,
    },

    radio_1: {
      speaker: 'رادیو',
      lines: [
        'در را می‌چرخانی. سوزشِ برق، بعد سکوت.',
        'صدایی می‌آید، خفه و دور — انگار از اتاق دیگری.',
        '«...امروز هم هیچ‌کس برنگشت. خانه شمارهٔ سیزده. کسی که رفت، دیگر نیست.»',
      ],
      set: { heard_radio1: true },
      choices: [
        { text: 'گوش دادن ادامه بده', to: 'radio_1b' },
        { text: 'خاموشش کن', to: 'radio_1off' },
      ],
    },

    radio_1b: {
      speaker: 'رادیو',
      lines: [
        '«می‌گویند آل از پنجره وارد می‌شود، ولی رد پایش برعکس است.»',
        '«اگر اسمت را صدا زد، جواب نده. اگر شمرد، تو بشمار — تا گم شود.»',
        'صدا قطع می‌شود. برق رادیو می‌شکند.',
      ],
      set: { lore_al: true, heard_radio1b: true },
      end: true,
    },

    radio_1off: {
      speaker: null,
      lines: [
        'کلید را می‌چرخانی. سکوت بدتری می‌آید — سکوتی که خودش صدا دارد.',
      ],
      end: true,
    },

    /* ================= LIVING ROOM ================= */

    mirror: {
      speaker: 'آینه',
      lines: [
        'گرد و خاک روی شیشه است. دستت را می‌کشی.',
        'انعکاست یک لحظه دیر حرکت می‌کند.',
      ],
      choices: [
        { text: 'بیشتر نگاه کن', to: 'mirror_deep' },
        { text: 'برگرد', to: 'mirror_leave' },
      ],
    },

    mirror_deep: {
      speaker: 'آینه',
      lines: [
        'در انعکاس، پشت سرت چیزی ایستاده است — بلند، بی‌رنگ، با چشم‌های کم‌سو.',
        'برمی‌گردی. هیچ‌کس نیست.',
        'اما روی شیشه، جای دستی مانده — از داخل.',
      ],
      set: { saw_mirror: true },
      story_item: 'نشانهٔ آینه',
      story_item_text:
        'در آینه چیزی دیدی که پشت سرت بود و نبود.\n' +
        'در فولکلور ایرانی، آل را با پاهای برعکس توصیف می‌کنند — همیشه پشت سرت است، ' +
        'حتی وقتی مطمئنی تنهایی.',
      end: true,
    },

    mirror_leave: {
      speaker: null,
      lines: ['روی شیشه دست می‌کشی. سرد است — سردتر از اتاق.'],
      end: true,
    },

    shelf: {
      speaker: 'قفسه',
      lines: [
        'کتاب‌ها پوسیده‌اند. یکی‌شان باز است، وسط یک صفحه.',
        '«...و آل را با نام می‌خوانند، نه با فریاد. هر که جواب داد، دیگر برنگشت.»',
      ],
      set: { lore_books: true },
      end: true,
    },

    note_mother: {
      speaker: 'یادداشت مادر',
      lines: [
        '«هر شب ساعت سه بیدار می‌شوم. روی سینه‌ام سنگینی است.»',
        '«به دکتر گفتم. گفت بختک است، فلج خواب. ولی بختک پنجره را باز نمی‌کند.»',
        '«پنجره باز بود. خاک روی طاقچه بود. اندازهٔ پای یک بچه.»',
      ],
      set: { lore_bakhtak: true, saw_mother_note: true },
      story_item: 'یادداشت مادر',
      story_item_text:
        'مادر از سنگینی روی سینه‌اش نوشته و دکتر گفته «بختک».\n' +
        'بختک نام واقعی فلج خواب در فرهنگ ایرانی است — و توصیفش همیشه همین است: ' +
        'وزنه‌ای روی سینه که نمی‌گذارد تکان بخوری.',
      end: true,
    },

    /* ================= KITCHEN ================= */

    sink: {
      speaker: null,
      lines: [
        'شیر چکه می‌کند. هر قطره با تأخیر می‌افتد — انگار کسی وقت‌بندی را عوض کرده.',
        'در سینک، موی بلندی است که مال هیچ‌کس این خانه نیست.',
      ],
      end: true,
    },

    note_kitchen: {
      speaker: 'لیست خرید',
      lines: [
        '«نان، شیر، شمع.»',
        'زیرش با دست خط دیگری نوشته شده:',
        '«شمع نه. آتش نبینند.»',
      ],
      set: { lore_fire: true },
      end: true,
    },

    radio_2: {
      speaker: 'رادیو',
      lines: [
        'این یکی روشن است، ولی هیچ فرستنده‌ای روی هیچ موجی نیست.',
        'صدایی می‌شمارد. آرام. یکی... دو... سه...',
      ],
      choices: [
        { text: 'با او بشمار', to: 'radio_2_count' },
        { text: 'خفه‌اش کن', to: 'radio_2_off' },
      ],
    },

    radio_2_count: {
      speaker: 'تو',
      lines: [
        'زیر لب می‌شماری. «چهار... پنج...»',
        'صدا می‌ایستد. در نیمهٔ کلمه.',
        'برای اولین بار در این خانه، یک لحظه سکوت واقعی است.',
      ],
      set: { counted_once: true },
      story_item: 'قاعدهٔ شمارش',
      story_item_text:
        'با او شمردی و ایستاد.\n' +
        'این یک باور واقعی در روایت‌های محلی است: موجودی که می‌شمارد، با شمردن ' +
        'حواسش پرت می‌شود — چون شمردن کارِ ذهنِ ساده است، نه ذهنِ تو.',
      end: true,
    },

    radio_2_off: {
      speaker: null,
      lines: ['دکمه را می‌فشاری. صدا قطع نمی‌شود. فقط آرام‌تر می‌شمارد.'],
      set: { radio2_angry: true },
      end: true,
    },

    /* ================= BEDROOM ================= */

    bed: {
      speaker: null,
      lines: [
        'ملافه مرتب است، ولی فرورفتگی بدن روی تشک مانده — دو تا. یکی کوچک‌تر.',
        'بالش کوچک بوی شیر می‌دهد.',
      ],
      set: { saw_bed: true },
      end: true,
    },

    desk_bedroom: {
      speaker: 'کشو',
      lines: [
        'کشو گیر کرده. با فشار باز می‌شود.',
        'داخلش، لای کاغذهای بیمصرف، یک کلید آهنی سنگین است — و کلیدی که با آن جور نیست.',
      ],
      gives: 'key_iron',
      set: { opened_desk_bed: true },
      end: true,
    },

    note_diary: {
      speaker: 'دفتر خاطرات',
      lines: [
        '«بچه‌ام دو هفته است شب‌ها گریه نمی‌کند. باید خوشحال باشم. نیستم.»',
        '«صدایش را از زیر زمین می‌شنوم، ولی آن‌جا قفل است.»',
        '«امروز صبح روی دستش نوشته بود: سیزده.»',
      ],
      set: { saw_diary: true, lore_al: true },
      story_item: 'دفتر خاطرات',
      story_item_text:
        'مادر می‌نویسد صدای بچه را از زیرزمین می‌شنود و زیرزمین قفل است.\n' +
        'در روایت‌های ایرانی دربارهٔ آل، مادر اولین کسی است که متوجه می‌شود — ' +
        'و اولین کسی که کسی حرفش را باور نمی‌کند.',
      end: true,
    },

    /* ================= BATHROOM ================= */

    tub: {
      speaker: null,
      lines: [
        'وان پر از آب سیاه است. آب سرد است، ولی بخار می‌کند.',
        'زیر آب، چیزی سفید تکان می‌خورد. نگاه نمی‌کنی.',
      ],
      set: { saw_tub: true },
      end: true,
    },

    blood_bath: {
      speaker: null,
      lines: [
        'لکه روی کف، خشک و تیره است — ولی مسیر دارد.',
        'مسیر به سمت دیوار می‌رود و روی دیوار تمام می‌شود. آن‌جا دری نیست.',
      ],
      end: true,
    },

    /* ================= CHILD ROOM ================= */

    bed_child: {
      speaker: null,
      lines: [
        'تخت کوچک است و از زیرش باد سرد می‌آید.',
        'روی دیوار کنار تخت، با مداد رنگی، سیزده خط کشیده شده.',
        'خط سیزدهم نیمه‌کاره است.',
      ],
      set: { saw_child_bed: true },
      story_item: 'سیزده خط',
      story_item_text:
        'بچه سیزده خط کشیده و خط آخر را تمام نکرده.\n' +
        'عدد سیزده در روایت‌های خانه‌های «اتاق سیزدهم» عدد مرزی است: اتاقی که ' +
        'در نقشه هست و در واقعیت نیست.',
      end: true,
    },

    crate_child: {
      speaker: 'جعبه',
      lines: [
        'جعبه اسباب‌بازی. درش را باز می‌کنی.',
        'داخلش نوار کاستی است با برچسب دست‌نویس: «صدای او».',
      ],
      gives: 'tape',
      set: { opened_crate_child: true },
      end: true,
    },

    flesh_child: {
      speaker: null,
      lines: [
        'چیزی روی زمین است که نباید گوشت باشد.',
        'تکان می‌خورد، ولی بدن ندارد. فقط تکان می‌خورد.',
        'عقب می‌کشی. چیزی تغییر نمی‌کند.',
      ],
      fear: 18,
      end: true,
    },

    /* ================= STUDY ================= */

    shelf_study: {
      speaker: 'کتاب‌ها',
      lines: [
        'قفسهٔ تحقیق عامیانه. کتابی باز مانده، با یادداشت‌های خط‌خورده.',
        '«آل از پنجره وارد می‌شود. با آتش نمی‌آید. با نام می‌آید.»',
        '«برای بستنش سه چیز لازم است: صدایش، نامش، و آن‌چه از او مانده.»',
      ],
      set: { lore_ritual: true, knows_ritual: true },
      story_item: 'راه بستن',
      story_item_text:
        'برای بستن آن سه چیز لازم است: صدایش، نامش، و آن‌چه از او مانده.\n' +
        'این ساختار سه‌گانه در آیین‌های عامیانهٔ ایرانی رایج است — اما خودِ ' +
        '«مراسم» این‌جا ساختگی و برای بازی است.',
      end: true,
    },

    desk_study: {
      speaker: 'میز کار',
      lines: [
        'روی میز، دست‌نوشته‌های یک نفر است که همه‌شان یک جمله را تکرار می‌کنند.',
        '«من جواب دادم.»',
        'زیر کاغذها، چیزی سخت است: کلیدی از استخوان.',
      ],
      gives: 'key_bone',
      set: { opened_desk_study: true },
      end: true,
    },

    note_study: {
      speaker: 'صفحه‌های آخر',
      lines: [
        '«فهمیدم چرا برنمی‌گردند. آن‌ها نمی‌میرند. آن‌ها جای کسی را می‌گیرند.»',
        '«اتاق سیزدهم جایی نیست. فاصله‌ای است بین دو نفر که یکی‌شان عوض شده.»',
        '«اگر این را می‌خوانی، اسم من یادت نیست. مال تو را هم به خاطر ندارم.»',
      ],
      set: { knows_truth: true },
      story_item: 'صفحه‌های آخر',
      story_item_text:
        'نویسنده فهمیده که این‌ها نمی‌میرند، جای کسی را می‌گیرند.\n' +
        'ایدهٔ «جایگزینی به‌جای کشتن» ریشه در باور به جن‌زدگی دارد: ' +
        'موجود جای می‌نشیند، نه اینکه نابود کند.',
      end: true,
    },

    /* ================= BASEMENT ================= */

    blood_basement: {
      speaker: null,
      lines: [
        'روی دیوار با چیزی که خون نیست نوشته شده:',
        '«سِیزده». عدد را از سمت راست نوشته‌اند — مثل کسی که خط نمی‌داند.',
      ],
      end: true,
    },

    crate_base: {
      speaker: 'صندوق',
      lines: [
        'خالی است، جز یک باتری و یک شمع سوخته.',
        'شمع را برمی‌داری — ولی یادت می‌آید: «آتش نبینند.»',
        'شمع را برمی‌گردانی.',
      ],
      gives: 'battery',
      end: true,
    },

    altar: {
      speaker: 'محراب',
      lines: [
        'سنگ سیاه، تراش‌نخورده، در مرکز اتاق. دور آن سیزده خط.',
        'روی سنگ، جای پنج انگشتِ کوچک است — داغ، هنوز.',
        'هوا می‌لرزد. چیزی این‌جا منتظر است.',
      ],
      fear: 12,
      set: { found_altar: true },
      end: true,
    },

    /* ================= CRYPT / ENDING ================= */

    flesh_crypt: {
      speaker: null,
      lines: [
        'در گوشه، چیزی است که نفس می‌کشد و بدن ندارد.',
        'باید فوراً بروی.',
      ],
      fear: 25,
      end: true,
    },

    finale: {
      speaker: 'اتاق آخر',
      lines: [
        'روی سنگ، آن‌چه از او مانده است.',
        'پشت سرت، درِ اتاق باز می‌شود. صدایی اسمت را می‌خواند — با صدای خودت.',
      ],
      choices: [
        { text: 'جواب بده', to: 'ending_answer', if: 'always' },
        { text: 'خاموشش کن — صدایش، نامش، و آن‌چه از او مانده',
          to: 'ending_ritual', if: 'has_ritual' },
        { text: 'نگاه نکن و فرار کن', to: 'ending_flee', if: 'always' },
      ],
    },

    /* --- ending A: you answer. The bad one, and the lore-correct one. --- */
    ending_answer: {
      speaker: 'صدا',
      lines: [
        'برمی‌گردی. جواب می‌دهی.',
        'برای یک لحظه، همه‌چیز عادی است. خانه گرم است. بوی غذا می‌آید.',
        'کسی از آشپزخانه صدایت می‌زند: «شام آماده است.»',
        'تو می‌روی.',
        '',
        'اتاق سیزدهم اتاقی نیست. فاصله‌ای است بین دو نفر که یکی‌شان عوض شده.',
        'و حالا تو آن فاصله‌ای.',
        '',
        '— پایان بد —',
      ],
      ending: 'bad',
      end: true,
    },

    /* --- ending B: the ritual. Needs the tape and the two ritual notes. --- */
    ending_ritual: {
      speaker: 'تو',
      lines: [
        'نوار را در رادیوی کنار سنگ می‌گذاری.',
        'صدای خودش می‌آید — برعکس، خفه، از زیر آب.',
        'با صدای بلند اسمش را می‌گویی: «آل.»',
        'و آن‌چه از او مانده را روی سنگ می‌گذاری.',
        '',
        'لرزه می‌ایستد. سنگ سرد می‌شود، و در سکوت، برای اولین بار،',
        'صدای هیچ‌کس نمی‌آید.',
        '',
        'از پله‌ها بالا می‌روی. چراغ‌ها روشن‌اند.',
        'اما در آینه، انعکاست یک لحظه دیر حرکت می‌کند.',
        '',
        '— بستن انجام شد —',
      ],
      ending: 'best',
      end: true,
    },

    /* --- ending C: flee. Neutral: alive, unresolved. --- */
    ending_flee: {
      speaker: null,
      lines: [
        'برنمی‌گردی. می‌دوی.',
        'در، پله، در، حیاط. نفس می‌کشی.',
        'زنده‌ای.',
        '',
        'فردا روزنامه چیزی نمی‌نویسد، چون خانه شمارهٔ سیزده روی هیچ نقشه‌ای نیست.',
        'اما هر شب ساعت سه، روی سینه‌ات سنگینی است.',
        '',
        '— فرار —',
      ],
      ending: 'flee',
      end: true,
    },
  },
};

/* --- ending metadata, kept next to the graph it describes ----------------- */
const ENDINGS = {
  bad:  { title: 'پایان بد',            text: 'جواب دادی. یکی از شما عوض شد.' },
  best: { title: 'بستن',                text: 'صدایش، نامش، و آن‌چه از او مانده.' },
  flee: { title: 'فرار',                text: 'زنده ماندی. تمام نشد.' },
};

/* --- validation: every node must terminate, continue, or branch ----------- */
function validateStory() {
  const problems = [];
  const ids = Object.keys(STORY.nodes);

  for (const id of ids) {
    const n = STORY.nodes[id];
    if (!n.lines || !n.lines.length) problems.push(`node '${id}' has no lines`);

    const terminal = n.end === true || n.ending;
    const hasNext = typeof n.next === 'string';
    const hasChoices = Array.isArray(n.choices) && n.choices.length > 0;

    if (!terminal && !hasNext && !hasChoices) {
      problems.push(`node '${id}' is a dead end: no end, next, or choices`);
    }
    if (hasNext && !STORY.nodes[n.next]) {
      problems.push(`node '${id}' points to missing next '${n.next}'`);
    }
    if (hasChoices) {
      for (const c of n.choices) {
        if (!c.to) problems.push(`node '${id}' has a choice with no target`);
        else if (!STORY.nodes[c.to]) problems.push(`node '${id}' choice points to missing '${c.to}'`);
        if (!c.text) problems.push(`node '${id}' has a choice with no text`);
      }
    }
  }

  if (!STORY.nodes[STORY.start]) problems.push(`start node '${STORY.start}' does not exist`);

  // Reachability from every entry point. The graph is NOT one chain from `start`:
  // each interactable object names its own entry node, so validating from `start`
  // alone reports ~30 false "unreachable" failures. OBJECTS is available because
  // world.js loads before story.js.
  const roots = new Set([STORY.start]);
  try {
    if (typeof OBJECTS !== 'undefined') for (const o of OBJECTS) if (o.story) roots.add(o.story);
  } catch (e) { /* OBJECTS not loaded — fall back to the single root */ }

  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const n = STORY.nodes[id];
    if (!n) continue;
    if (n.next) stack.push(n.next);
    if (n.choices) for (const c of n.choices) if (c.to) stack.push(c.to);
  }
  for (const id of ids) {
    if (!seen.has(id)) problems.push(`node '${id}' is unreachable from every entry point`);
  }

  // Every ending declared in ENDINGS must be produced by some node.
  const produced = new Set(ids.map((i) => STORY.nodes[i].ending).filter(Boolean));
  for (const e of Object.keys(ENDINGS)) {
    if (!produced.has(e)) problems.push(`ending '${e}' is declared but no node reaches it`);
  }

  return problems;
}
