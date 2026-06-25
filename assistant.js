import Anthropic from "@anthropic-ai/sdk";
import {
  createEvent,
  checkRoomAvailability,
  listRoomEvents,
  listMergedEvents,
  listMyEvents,
  calendarConfigured,
  TIME_ZONE,
} from "./calendar.js";
import { buildSystemPrompt } from "./system-prompt.js";
import {
  memoryConfigured,
  getMemories,
  addMemory,
  forgetMemory,
  memoryPromptSection,
} from "./memory.js";
import {
  contactsConfigured,
  findPeople,
  createPerson,
  updatePerson,
  createInteraction,
  createEvent as createConnectomeEvent,
  upcomingFollowups,
  createRelationship,
  tagPerson,
  addPersonToOrganization,
  syncPeople,
} from "./contacts.js";
import { sessionConfigured, loadSession, saveSession } from "./session.js";
import { recordTranscript } from "./transcript.js";
import {
  knowledgeConfigured,
  knowledgeCanSearch,
  knowledgeLabel,
  saveNote,
  searchNotes,
} from "./knowledge.js";
import { todosConfigured, addTodo, listTodos, completeTodo } from "./todos.js";
import { ownerName, assistantName } from "./profile.js";

// ── 環境變數 ──────────────────────────────────────────────
const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  console.error("❌ 缺少 ANTHROPIC_API_KEY");
  process.exit(1);
}

const client = new Anthropic({ apiKey });

// ── 可選模型清單 ───────────────────────────────────────────
const MODELS = {
  opus: { id: "claude-opus-4-8", label: "Opus 4.8 🧠（最聰明）" },
  sonnet: { id: "claude-sonnet-4-6", label: "Sonnet 4.6 🐇（快又省）" },
  haiku: { id: "claude-haiku-4-5", label: "Haiku 4.5 ⚡（最快最便宜）" },
};

const DEFAULT_KEY = (process.env.CLAUDE_MODEL || "opus").toLowerCase();
const DEFAULT_MODEL_KEY = MODELS[DEFAULT_KEY] ? DEFAULT_KEY : "opus";

const userModels = new Map(); // userId -> modelKey
function modelKeyFor(userId) {
  return userModels.get(userId) || DEFAULT_MODEL_KEY;
}

// ── system prompt 已拆成具名區塊，見 system-prompt.js（buildSystemPrompt / listBlocks）──

// ── 工具定義 ───────────────────────────────────────────────
const TOOLS = [
  {
    name: "create_calendar_event",
    description:
      "在使用者的 Google 日曆建立一個事件。當使用者要約會議、提醒、預約、安排行程等需要記到行事曆的事情時使用。",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "事件標題，例如「跟老王見面」" },
        start: {
          type: "string",
          description:
            "開始時間，ISO 8601 含時區，例如 2026-06-12T09:00:00+08:00",
        },
        end: {
          type: "string",
          description:
            "結束時間，ISO 8601 含時區。若使用者沒說，預設為開始後一小時。",
        },
        location: { type: "string", description: "地點（可選）" },
        description: { type: "string", description: "備註（可選）" },
        attendees: {
          type: "array",
          items: { type: "string" },
          description:
            "與會者 email 清單（可選）。要邀請的人或會議室資源的 email 都放這。",
        },
      },
      required: ["title", "start", "end"],
    },
  },
  {
    name: "check_room_availability",
    description:
      "查一間或多間會議室在某段時間有沒有被預約（忙/閒）。當使用者問「C 早上有沒有人用」「B 下午空不空」「哪間會議室現在有空」等查詢會議室使用狀況時使用。可一次查多間做比較。會回傳每間在該時段內已被預約的區間。",
    input_schema: {
      type: "object",
      properties: {
        room_emails: {
          type: "array",
          items: { type: "string" },
          description:
            "要查的會議室 resource email 清單（用上面快捷對照表把代號換成 email）。要比較多間就全放進來。",
        },
        start: {
          type: "string",
          description:
            "查詢區間開始，ISO 8601 含時區，例如 2026-06-12T08:00:00+08:00。使用者講「早上」就用當天 08:00、「下午」用 13:00 等合理範圍。",
        },
        end: {
          type: "string",
          description: "查詢區間結束，ISO 8601 含時區，例如 2026-06-12T12:00:00+08:00。",
        },
      },
      required: ["room_emails", "start", "end"],
    },
  },
  {
    name: "list_room_events",
    description:
      "列出一間（或多間）會議室在某段時間實際排了哪些行程，連活動名稱＋時間一起回。和 check_room_availability 的差別：這個會回『是什麼活動』。最常用在：使用者問「SPACE 有沒有課／這週有什麼課／X 月課表」——SPACE 教室的課程會佔用日曆 SPACE 資源，直接查日曆就好，不必去翻年度課表試算表。也可用來回答「C 室那個時段是誰在用、開什麼」。",
    input_schema: {
      type: "object",
      properties: {
        room_emails: {
          type: "array",
          items: { type: "string" },
          description:
            "要查的會議室 resource email 清單（用上面快捷對照表把代號換成 email；問 SPACE 課就放 SPACE 的 email）。",
        },
        start: {
          type: "string",
          description:
            "查詢區間開始，ISO 8601 含時區。問「這週」「這個月」「X 月課表」就換算成合理的起訖，例如整月就用該月 1 號 00:00。",
        },
        end: {
          type: "string",
          description: "查詢區間結束，ISO 8601 含時區。",
        },
      },
      required: ["room_emails", "start", "end"],
    },
  },
  {
    name: "list_my_events",
    description:
      "列出 Casper 自己日曆上的行程（會合併 Google 日曆＋iCal 並去重，就是晨報用的那份）。使用者問「今天有什麼行程／我今天要幹嘛／這週有哪些會／明天行程」這類『我自己的行程』時用這個。和會議室工具的差別：這個查的是 Casper 本人的行程，不是某間會議室。回傳每筆的標題、起訖時間、地點、與會者。",
    input_schema: {
      type: "object",
      properties: {
        start: {
          type: "string",
          description:
            "查詢區間開始，ISO 8601 含時區。「今天」就用今天 00:00（台北），「這週」用本週起點，依此類推。",
        },
        end: {
          type: "string",
          description: "查詢區間結束，ISO 8601 含時區。「今天」就用今天 23:59。",
        },
      },
      required: ["start", "end"],
    },
  },
  {
    name: "remember",
    description:
      "把關於『Casper 本人』值得長期記住的事實或偏好寫進長期記憶。用在：Casper 自己的習慣、喜好、工作方式、重要背景。" +
      "【嚴格界線】這個工具只記 Casper 自己的事。任何關於『別人』的資訊（別人的生日、電話、公司、職稱、喜好、互動）都不要用這個——那些要用 Connectome 的 create_person / update_person / tag_person。一次性或有時效性的瑣事也不要記。",
    input_schema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description:
            "要記住的事實，寫成簡潔的一句話，例如「開會習慣訂 B 會議室」",
        },
        category: {
          type: "string",
          description: "分類標籤（可選），例如 偏好 / 人事物 / 工作 / 個人",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "forget",
    description:
      "刪除一條長期記憶。當使用者要你忘記某件事時使用。memory_id 是目前記憶清單裡該條前面的編號。",
    input_schema: {
      type: "object",
      properties: {
        memory_id: {
          type: "integer",
          description: "要刪除的記憶編號（對應目前記憶清單的編號）",
        },
      },
      required: ["memory_id"],
    },
  },
  {
    name: "find_person",
    description:
      "在 Casper 的人脈庫 Connectome 搜尋聯絡人。要查某人的電話/生日/公司，或在記互動、建關係、貼標籤前需要拿到對方的 person id，都先用這個。回傳符合的候選人清單（含 id）。對不到就回空清單，這時要反問 Casper。",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "要搜尋的名字、暱稱、公司或 email，例如「王醫師」「Victor」",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "create_person",
    description:
      "在 Connectome 新增一位聯絡人。只有 name 必填，其餘有就帶。新增前若不確定是否已存在，先用 find_person 查，並向 Casper 確認。系統有自動去重保險：若電話／email 相同或同名同公司，會自動改成『更新既有那筆』而不是新增——這時工具回覆會說明是更新，請照實回報給 Casper，不要再硬建一筆。",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "姓名（必填）" },
        company: { type: "string", description: "公司／單位" },
        title: { type: "string", description: "職稱" },
        email: { type: "string", description: "email" },
        phone: { type: "string", description: "電話" },
        birthday: {
          type: "string",
          description: "生日，格式 YYYY-MM-DD。缺年份就先問 Casper。",
        },
        city: { type: "string", description: "城市" },
        first_met_date: {
          type: "string",
          description: "初次見面日期，格式 YYYY-MM-DD（交換名片當天通常就是今天）",
        },
        first_met_place: {
          type: "string",
          description: "初次見面的場合／地點（例如「BNI 例會」「牙醫公會年會」）",
        },
        notes: { type: "string", description: "備註（喜好、背景、認識緣由等）" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_person",
    description:
      "更新某位聯絡人的資料（先用 find_person 拿到 person_id）。只帶要改的欄位。可以改名字（name）、暱稱（nickname）等。",
    input_schema: {
      type: "object",
      properties: {
        person_id: { type: "integer", description: "要更新的人的 id" },
        name: { type: "string", description: "更正後的姓名" },
        nickname: { type: "string", description: "暱稱" },
        english_name: { type: "string", description: "英文名" },
        company: { type: "string" },
        title: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        birthday: { type: "string", description: "YYYY-MM-DD" },
        city: { type: "string" },
        first_met_date: { type: "string", description: "初次見面日期 YYYY-MM-DD" },
        first_met_place: { type: "string", description: "初次見面的場合／地點" },
        notes: { type: "string", description: "備註（會覆蓋原備註，需要保留舊的就自行合併）" },
      },
      required: ["person_id"],
    },
  },
  {
    name: "create_event",
    description:
      "在 Connectome 建立一個 Event（活動）。**只在多人行程（你+2人以上）時用**：先建 Event 拿到 event_id，再對每位參與者各建一筆 log_interaction 並帶上這個 event_id。一對一行程不要建 Event。",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "活動名稱，例如「牙科領袖營會議」" },
        date: { type: "string", description: "活動日期 YYYY-MM-DD" },
        location: { type: "string", description: "地點（可選）" },
        notes: { type: "string", description: "備註（可選）" },
      },
      required: ["name", "date"],
    },
  },
  {
    name: "log_interaction",
    description:
      "在 Connectome 記一筆互動／會議。約了會議、見了面、通了電話、聊了重要的事都可記。participant_ids 用 find_person 對到的人。多人行程時：每位參與者各呼叫一次本工具（participant_ids 各放一人），並都帶上同一個 event_id。",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "互動日期 YYYY-MM-DD（會議當天）" },
        summary: { type: "string", description: "一句話摘要這次互動" },
        participant_ids: {
          type: "array",
          items: { type: "integer" },
          description:
            "與會者的 person id 清單（用 find_person 取得）。多人行程時每筆只放一人。",
        },
        event_id: {
          type: "integer",
          description: "連到的 Event id（多人行程時帶，來自 create_event）。一對一不用帶。",
        },
        type: {
          type: "string",
          description:
            "互動類型：meeting / dinner / event / online_meeting / call / chat / email / other，預設 meeting",
        },
        next_steps: { type: "string", description: "下一步要做的事（可選）" },
        follow_up_date: {
          type: "string",
          description: "下次跟進日期 YYYY-MM-DD（可選）",
        },
        location: { type: "string", description: "地點（可選）" },
      },
      required: ["date", "summary"],
    },
  },
  {
    name: "list_followups",
    description:
      "列出近期該跟進的互動（依 follow_up_date，含逾期）。Casper 問「這週／今天要跟進誰」時用。",
    input_schema: {
      type: "object",
      properties: {
        within_days: {
          type: "integer",
          description: "往後幾天內要跟進的（預設 7 天）",
        },
      },
    },
  },
  {
    name: "list_pending_meetings",
    description:
      "列出「待約會議」清單：來源是 Connectome 互動的 follow_up，像要約見面的排前面、其餘待跟進排後面，已排進未來日曆的會標「✅ 日曆已約」。Casper 想看待約清單時用（例如「看待約」「待約清單」「有哪些還沒約」「誰還沒約」）。但「待約 ○○」（要把某人/某事加進清單）不是用這個工具，而是走 log_interaction 設 follow_up、不訂日曆。回傳的是排好版的文字，直接照原樣回給 Casper、不要重新整理。",
    input_schema: {
      type: "object",
      properties: {
        within_days: {
          type: "integer",
          description: "往後幾天內的待約／待跟進（含逾期，預設 30 天）",
        },
      },
    },
  },
  {
    name: "create_relationship",
    description:
      "在 Connectome 建立兩個人之間的關係。要幫人引薦時用 type=introducer。兩個 person_id 都要先用 find_person 對到、且都已存在於 Connectome。",
    input_schema: {
      type: "object",
      properties: {
        person_a_id: { type: "integer", description: "第一個人的 id" },
        person_b_id: { type: "integer", description: "第二個人的 id" },
        type: {
          type: "string",
          description:
            "關係類型：introducer（引薦）/ friend / collaborator / partner / mentor / client / supplier / advisor / investor / acquaintance",
        },
        notes: { type: "string", description: "備註，例如為什麼介紹（可選）" },
      },
      required: ["person_a_id", "person_b_id", "type"],
    },
  },
  {
    name: "tag_person",
    description:
      "幫某位聯絡人貼標籤。特殊資源用 tag_type=resource，興趣／喜好用 interest，技能用 skill，產業用 industry。" +
      "（組織／學校／社團「歸屬」不要用這個——改用 add_to_organization，那會建立真正的組織成員關係並自動補組織標籤。）先用 find_person 拿到 person_id。",
    input_schema: {
      type: "object",
      properties: {
        person_id: { type: "integer", description: "要貼標籤的人的 id" },
        tag_name: { type: "string", description: "標籤文字，例如「牙材通路」「高爾夫」" },
        tag_type: {
          type: "string",
          description: "標籤型別：resource / interest / skill / industry / region / project，預設 interest",
        },
      },
      required: ["person_id", "tag_name"],
    },
  },
  {
    name: "add_to_organization",
    description:
      "把某位聯絡人加進一個組織（Connectome 真正的 Organizations 成員，會自動順帶補上組織標籤），可同時加進該組織底下的次組織（sub-group / community，例如 AAMA 底下的「AAMA第七期」「APEC小組」）。" +
      "用於 Casper 說某人是他某組織的同學／校友／同事／成員時。Casper 常用斜線寫階層，例如「AAMA/七期/APEC小組」＝組織 AAMA＋次組織「七期」「APEC小組」：把第一段放 organization_name、其餘各段放 sub_groups。先用 find_person 拿到 person_id。" +
      "若回傳 needs_confirm：scope=organization 表示組織沒完全同名、scope=community 表示某個次組織沒對到；看 suggestions 改用既有正確名稱重呼叫，或先問 Casper 再帶 create=true 建立。",
    input_schema: {
      type: "object",
      properties: {
        person_id: { type: "integer", description: "要加入組織的人的 id" },
        organization_name: { type: "string", description: "組織名稱，例如「台大土木」「BNI」「AAMA」（斜線路徑的第一段）" },
        sub_groups: {
          type: "array",
          items: { type: "string" },
          description: "該組織底下的次組織名稱，例如 [\"七期\",\"APEC小組\"]（斜線路徑第一段之後的各段）。沒有就省略。",
        },
        org_type: {
          type: "string",
          description:
            "建立新組織時的型別：alumni（同學/校友/班）/ business_association（商會/公會）/ startup_community（創業社群）/ company（公司）。預設 alumni。",
        },
        create: {
          type: "boolean",
          description: "找不到同名組織或次組織時，是否新建（預設 false；要先跟 Casper 確認過才設 true）",
        },
      },
      required: ["person_id", "organization_name"],
    },
  },
  {
    name: "save_note",
    description:
      "把 Casper 的一個決策（或值得進知識庫的重要內容：會議結論、策略想法）存進他的個人知識庫。" +
      "當 Casper 說「我決定…」「拍板了」或要你「記進知識庫／存筆記」時使用。text 請整理成結構化格式（# 決策：標題／決策日期／決策內容／為什麼／考慮過的替代方案／參與者）。" +
      "【界線】這不是 remember（個人偏好）——決策與知識內容才走這裡。",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "決策／筆記的一句話標題，例如「NeruMore 先不做 B2C」",
        },
        text: {
          type: "string",
          description: "結構化整理後的完整內容（含決策內容、為什麼、替代方案、參與者等，知道多少寫多少）",
        },
      },
      required: ["title", "text"],
    },
  },
  {
    name: "search_notes",
    description:
      "查 Casper 的個人知識庫（RAG 問答，答案附來源）。當 Casper 問過往決策或知識庫內容——「我當初為什麼決定…」「○○定價多少」「之前那個案子怎麼談的」——時使用。" +
      "查「人」的聯絡資料用 find_person（人脈庫），查「決策／專案／文件內容」才用這個。",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "要問知識庫的問題，用完整句子" },
      },
      required: ["question"],
    },
  },
  {
    name: "add_todo",
    description:
      "新增一筆待辦事項。Casper 說「提醒我…」「要記得做…」「週五前要…」這種有完成狀態的事時使用。" +
      "【界線】有明確開始時間的會議／行程→ create_calendar_event；長期事實偏好→ remember；要做的事才是待辦。",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "要做的事，簡潔一句話" },
        due_date: {
          type: "string",
          description: "到期日 YYYY-MM-DD（可選）。「週五前」就換算成那個週五的日期。",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "list_todos",
    description:
      "列出待辦清單（預設只列未完成、依到期日排序、含編號）。Casper 問「我有什麼待辦」「這週要做什麼」時，或要 complete_todo 前對編號時使用。",
    input_schema: {
      type: "object",
      properties: {
        include_done: {
          type: "boolean",
          description: "true 時連已完成的也列出來（預設 false）",
        },
      },
    },
  },
  {
    name: "complete_todo",
    description:
      "把一筆待辦標記為完成。todo_id 是 list_todos 回傳的編號；不確定編號就先 list_todos 對一下。",
    input_schema: {
      type: "object",
      properties: {
        todo_id: { type: "integer", description: "要完成的待辦編號（1-based）" },
      },
      required: ["todo_id"],
    },
  },
];

// ── 工具 → 能力 對照（M3：依啟用能力動態暴露工具）──────────────
// 每個工具屬於哪個能力；buildTools() 只把「該能力已設定」的工具給 Claude，
// 缺能力的工具連看都看不到（runTool 那層也各自有 Configured 防呆，雙保險）。
const TOOL_CAPABILITY = {
  create_calendar_event: "calendar",
  check_room_availability: "calendar",
  list_room_events: "calendar",
  list_my_events: "calendar",
  remember: "memory",
  forget: "memory",
  find_person: "contacts",
  create_person: "contacts",
  update_person: "contacts",
  create_event: "contacts",
  log_interaction: "contacts",
  list_followups: "contacts",
  list_pending_meetings: "contacts",
  create_relationship: "contacts",
  tag_person: "contacts",
  add_to_organization: "contacts",
  save_note: "knowledge",
  search_notes: "knowledge",
  add_todo: "todos",
  list_todos: "todos",
  complete_todo: "todos",
};

function capabilityEnabled() {
  return {
    calendar: calendarConfigured,
    memory: memoryConfigured,
    contacts: contactsConfigured,
    knowledge: knowledgeConfigured,
    todos: todosConfigured,
  };
}

// 工具定義裡仍寫死的主人名（含巢狀 schema description）→ 用 JSON round-trip 深層換成當下 ownerName()。
// 放在 buildTools 而非靜態 TOOLS，名字才能反映「網頁即時改名」（TOOLS 是 module 載入時就凍結的 const）。
function debrandTool(tool, owner) {
  const json = JSON.stringify(tool);
  if (!json.includes("Casper")) return tool;
  return JSON.parse(json.split("Casper").join(owner));
}

// 每請求動態組工具清單：只留已啟用能力的工具，並把主人名換成當下值。
export function buildTools() {
  const enabled = capabilityEnabled();
  const owner = ownerName();
  return TOOLS.filter((t) => {
    // search_notes 只在「知識庫 provider 支援查詢」時暴露（Obsidian v1 只能 capture）
    if (t.name === "search_notes" && !knowledgeCanSearch) return false;
    const cap = TOOL_CAPABILITY[t.name];
    return cap ? enabled[cap] : true; // 沒列在表內的工具（理論上不會有）預設保留
  }).map((t) => debrandTool(t, owner));
}

// 把 API 回傳的人物物件挑出指定欄位，組成可讀字串（用來回報「實際存了什麼」）
function echoFields(person, keys) {
  return (
    keys
      .filter((k) => k !== "person_id")
      .map((k) => `${k}=${person?.[k] ?? "(空)"}`)
      .join("、") || "（無）"
  );
}

// 執行工具，回傳給 Claude 的 tool_result 內容字串
async function runTool(name, input, userId) {
  if (name === "create_calendar_event") {
    if (!calendarConfigured) {
      return "行事曆功能還沒設定好（缺 Google 憑證），請告知使用者稍後再試。";
    }
    const ev = await createEvent(input);
    return `已建立事件成功。連結：${ev.htmlLink}`;
  }
  if (name === "check_room_availability") {
    if (!calendarConfigured) {
      return "行事曆功能還沒設定好（缺 Google 憑證），請告知使用者稍後再試。";
    }
    const results = await checkRoomAvailability({
      roomEmails: input.room_emails,
      start: input.start,
      end: input.end,
    });
    // 整理成精簡文字給 Claude 判讀（含每間的忙碌區間或「整段空閒」）
    const lines = results.map((r) => {
      if (r.error) {
        return `${r.email}：查不到（${r.error}，可能沒有讀取權限）`;
      }
      if (!r.busy.length) {
        return `${r.email}：查詢區間內全空閒（沒有預約）`;
      }
      const slots = r.busy.map((b) => `${b.start}~${b.end}`).join("、");
      return `${r.email}：已被預約 ${slots}`;
    });
    return `會議室查詢結果（查詢區間 ${input.start} ~ ${input.end}）：\n${lines.join("\n")}`;
  }
  if (name === "list_room_events") {
    if (!calendarConfigured) {
      return "行事曆功能還沒設定好（缺 Google 憑證），請告知使用者稍後再試。";
    }
    const results = await listRoomEvents({
      roomEmails: input.room_emails,
      start: input.start,
      end: input.end,
    });
    const lines = results.map((r) => {
      if (r.error) {
        return `${r.email}：查不到（${r.error}，可能沒有讀取權限）`;
      }
      if (!r.events.length) {
        return `${r.email}：查詢區間內沒有任何行程（沒課／沒會議）`;
      }
      const items = r.events
        .map((e) => `${e.start}~${e.end} ${e.title}`)
        .join("\n  ");
      return `${r.email}：\n  ${items}`;
    });
    return `會議室行程查詢結果（查詢區間 ${input.start} ~ ${input.end}）：\n${lines.join("\n")}`;
  }
  if (name === "list_my_events") {
    if (!calendarConfigured) {
      return "行事曆功能還沒設定好（缺 Google 憑證），請告知使用者稍後再試。";
    }
    const events = await listMergedEvents({ start: input.start, end: input.end });
    if (!events.length) {
      return `查詢區間 ${input.start} ~ ${input.end} 內，${ownerName()} 的日曆沒有任何行程。`;
    }
    const lines = events.map((e) => {
      const when = e.allDay ? `${e.start}（整天）` : `${e.start}~${e.end}`;
      const where = e.location ? `｜${e.location}` : "";
      const others = (e.attendees || []).filter((a) => !a.self && !a.resource);
      const who = others.length
        ? `｜與會：${others.map((a) => a.name || a.email).join("、")}`
        : "";
      return `${when} ${e.title}${where}${who}`;
    });
    return `${ownerName()} 的行程（查詢區間 ${input.start} ~ ${input.end}）：\n${lines.join("\n")}`;
  }
  if (name === "remember") {
    if (!memoryConfigured) {
      return "長期記憶功能還沒設定好（缺試算表設定），請告知使用者稍後再試。";
    }
    const m = await addMemory(userId, input.category, input.content);
    return `已記住：${m.content}`;
  }
  if (name === "forget") {
    if (!memoryConfigured) {
      return "長期記憶功能還沒設定好（缺試算表設定）。";
    }
    const removed = await forgetMemory(input.memory_id);
    return removed
      ? `已刪除記憶：${removed.content}`
      : `找不到編號 ${input.memory_id} 的記憶。`;
  }

  // ── 知識庫（決策日誌／個人知識庫，provider 二選一：MyWiki / Obsidian）──
  if (name === "save_note") {
    if (!knowledgeConfigured) {
      return "知識庫還沒設定好（沒接 MyWiki 或 Obsidian），請告知使用者稍後再試。";
    }
    const r = await saveNote({ title: input.title, text: input.text });
    const title = r?.title || input.title;
    return `已存進知識庫（${knowledgeLabel}，標題：${title}），系統正在背景整理，稍後就能查到。`;
  }
  if (name === "search_notes") {
    if (!knowledgeConfigured) {
      return "知識庫還沒設定好（沒接 MyWiki 或 Obsidian），請告知使用者稍後再試。";
    }
    if (!knowledgeCanSearch) {
      return `目前的知識庫（${knowledgeLabel}）只支援存筆記、還不能查詢，請告知使用者。`;
    }
    const r = await searchNotes(input.question);
    const sources = (r.citations || [])
      .map((c) => `[${c.n}]《${c.title}》${c.page ? ` 第${c.page}頁` : ""}`)
      .join("、");
    return `知識庫（${knowledgeLabel}）的回答：\n${r.answer}\n\n來源：${sources || "（沒有檢索到來源）"}\n（回覆 ${ownerName()} 時保留重點與關鍵來源，不用全文照貼）`;
  }

  // ── 待辦清單 ───────────────────────────────────────────────
  if (name === "add_todo") {
    if (!todosConfigured) {
      return "待辦功能還沒設定好（缺記憶試算表設定），請告知使用者稍後再試。";
    }
    const t = await addTodo(input.content, input.due_date);
    return `已加入待辦：${t.content}${t.due ? `（到期日 ${t.due}）` : ""}`;
  }
  if (name === "list_todos") {
    if (!todosConfigured) {
      return "待辦功能還沒設定好（缺記憶試算表設定）。";
    }
    const items = await listTodos(Boolean(input.include_done));
    if (!items.length) return "待辦清單目前是空的 ✅";
    const lines = items
      .map(
        (t) =>
          `${t.id}. ${t.content}${t.due ? `（${t.due} 前）` : ""}${t.status === "done" ? " ✔已完成" : ""}`
      )
      .join("\n");
    return `待辦清單（${items.length} 筆）：\n${lines}`;
  }
  if (name === "complete_todo") {
    if (!todosConfigured) {
      return "待辦功能還沒設定好（缺記憶試算表設定）。";
    }
    const done = await completeTodo(input.todo_id);
    return done
      ? `已完成：${done.content} ✔`
      : `找不到編號 ${input.todo_id} 的未完成待辦，先用 list_todos 對一下編號。`;
  }

  // ── Connectome 人脈工具 ──────────────────────────────────
  if (
    name === "find_person" ||
    name === "create_person" ||
    name === "update_person" ||
    name === "create_event" ||
    name === "log_interaction" ||
    name === "list_followups" ||
    name === "list_pending_meetings" ||
    name === "create_relationship" ||
    name === "tag_person" ||
    name === "add_to_organization"
  ) {
    if (!contactsConfigured) {
      return "人脈功能（Connectome）還沒設定好（缺 CONNECTOME_EMAIL / CONNECTOME_PASSWORD），請告知使用者稍後再試。";
    }
    if (name === "find_person") {
      const matches = await findPeople(input.query);
      if (!matches.length) {
        return `Connectome 裡找不到符合「${input.query}」的人。請反問 ${ownerName()} 是否要新增，或提供更明確的資訊。`;
      }
      return `找到 ${matches.length} 位候選：\n${JSON.stringify(matches)}`;
    }
    if (name === "create_person") {
      const { person, action, changed, existing } = await createPerson(input);
      if (action === "updated") {
        if (!changed.length) {
          return `Connectome 裡已經有這個人了（id=${person.id}，姓名「${person.name}」${
            existing.company ? `／${existing.company}` : ""
          }），而且資料都一樣，沒有新增也沒有更動。請這樣回報給 ${ownerName()}，別再另建一筆。`;
        }
        return `這個人 Connectome 裡已經存在（id=${person.id}，姓名「${person.name}」），所以**沒有另建新檔**，改成把新資料補上去了。更新後的值：${echoFields(
          person,
          changed
        )}。請告訴 ${ownerName()} 是「更新既有聯絡人」而不是新增。`;
      }
      return `已新增聯絡人（id=${person.id}）。Connectome 實際存的值：${echoFields(person, Object.keys(input))}`;
    }
    if (name === "update_person") {
      const { person_id, ...fields } = input;
      const p = await updatePerson(person_id, fields);
      return `已更新聯絡人（id=${p.id}）。Connectome 實際存的值：${echoFields(p, Object.keys(fields))}`;
    }
    if (name === "create_event") {
      const ev = await createConnectomeEvent({
        name: input.name,
        date: input.date,
        location: input.location,
        notes: input.notes,
      });
      return `已建立 Event：${ev.name}（event_id=${ev.id}）。接著對每位參與者各建一筆 log_interaction，並帶上 event_id=${ev.id}。`;
    }
    if (name === "log_interaction") {
      const it = await createInteraction({
        date: input.date,
        summary: input.summary,
        participant_ids: input.participant_ids || [],
        event_id: input.event_id,
        type: input.type || "meeting",
        next_steps: input.next_steps,
        follow_up_date: input.follow_up_date,
        location: input.location,
      });
      return `已在 Connectome 記下互動（id=${it.id}，${input.date}${
        input.location ? `，地點：${input.location}` : ""
      }${input.event_id ? `，event_id=${input.event_id}` : ""}）。`;
    }
    if (name === "list_followups") {
      const items = await upcomingFollowups(input.within_days || 7);
      if (!items.length) {
        return `未來 ${input.within_days || 7} 天內沒有設定要跟進的事。`;
      }
      return `要跟進的（${items.length} 筆）：\n${JSON.stringify(items)}`;
    }
    if (name === "list_pending_meetings") {
      return buildPendingMeetingsText(input.within_days || 30);
    }
    if (name === "create_relationship") {
      await createRelationship({
        person_a_id: input.person_a_id,
        person_b_id: input.person_b_id,
        type: input.type,
        notes: input.notes,
      });
      return `已建立關係（${input.type}）。`;
    }
    if (name === "tag_person") {
      const tag = await tagPerson(input.person_id, input.tag_name, input.tag_type);
      return `已幫該聯絡人貼上標籤「${tag.name}」（${tag.type}）。`;
    }
    if (name === "add_to_organization") {
      const r = await addPersonToOrganization(input.person_id, input.organization_name, {
        type: input.org_type,
        create: Boolean(input.create),
        subGroups: Array.isArray(input.sub_groups) ? input.sub_groups : [],
      });
      if (!r.ok && r.needs_confirm) {
        const sug = r.suggestions?.length ? `相近的既有名稱：${r.suggestions.join("、")}。` : "";
        if (r.scope === "community") {
          return `組織「${r.org.name}」底下沒有完全同名的次組織「${r.subGroup}」。${sug}請改用既有正確名稱再呼叫一次；若確定是新的，先跟 ${ownerName()} 確認後帶 create=true。現有次組織：${(r.existing || []).join("、")}`;
        }
        return `Connectome 裡沒有完全同名的組織「${input.organization_name}」。${sug}請改用既有正確名稱再呼叫一次；若確定是新組織，先跟 ${ownerName()} 確認後帶 create=true。現有組織：${(r.existing || []).join("、")}`;
      }
      const subTxt = r.communities?.length ? `，並加入次組織：${r.communities.join("、")}` : "";
      return `已把這個人加進組織「${r.org.name}」${r.created ? "（新建的組織）" : ""}${subTxt}，con 也自動補上了組織標籤。`;
    }
  }

  return `未知的工具：${name}`;
}

// ── 短期對話記憶 ───────────────────────────────────────────
const histories = new Map();
const MAX_TURNS = 12;

function getHistory(userId) {
  if (!histories.has(userId)) histories.set(userId, []);
  return histories.get(userId);
}

function pushHistory(userId, role, content) {
  const h = getHistory(userId);
  h.push({ role, content });
  if (h.length > MAX_TURNS) h.splice(0, h.length - MAX_TURNS);
}

// ── 對話記憶持久化（重啟／重部署不失憶）────────────────────
// 第一次碰到某使用者時，從試算表把存著的對話載回 RAM；每輪結束後再寫回去。
const hydrated = new Set();
async function ensureHydrated(userId) {
  if (hydrated.has(userId)) return;
  hydrated.add(userId); // 先標記，擋同時多次載入
  if (!sessionConfigured) return;
  try {
    const saved = await loadSession(userId);
    if (saved.length) {
      const existing = histories.get(userId) || [];
      histories.set(userId, [...saved, ...existing].slice(-MAX_TURNS));
    }
  } catch (e) {
    console.error("載入對話記憶失敗（下則訊息再試）：", e.message);
    hydrated.delete(userId); // 允許下次重試
  }
}
function persistSession(userId) {
  if (!sessionConfigured) return;
  saveSession(userId, histories.get(userId) || []).catch((e) =>
    console.error("存對話記憶失敗：", e.message)
  );
}

/**
 * 把「77 主動推播出去的訊息」記進對話歷史（當成 assistant 發言），
 * 這樣 Casper 對推播的回覆（「好，記一下」）才接得上文。
 */
export function notePush(userId, text) {
  pushHistory(userId, "assistant", text);
  // 已載入過才寫回，避免在尚未 hydrate 時用單一推播覆蓋掉存著的對話
  if (hydrated.has(userId)) persistSession(userId);
  recordTranscript(assistantName(), text); // 主動推播（會議監看／通知／問題提醒）也進完整存檔
}

/**
 * 判斷 Casper 這則訊息「回答／處理了」哪些 77 還在等回覆的問題。
 * 換話題、講別的事不算回答。回傳被回答到的問題索引陣列（0-based）；
 * 失敗時回空陣列（＝視為都沒答到，鬧鐘保留，符合「要持續」的需求）。
 */
export async function classifyAnsweredQuestions(pendingTexts, userMessage) {
  if (!pendingTexts?.length || !userMessage) return [];
  try {
    const list = pendingTexts.map((q, i) => `${i}. ${q}`).join("\n");
    const res = await client.messages.create({
      model: MODELS.haiku.id,
      max_tokens: 60,
      thinking: { type: "disabled" },
      system:
        "你在判斷使用者最新訊息回答了下面哪幾個『助理還在等回覆的問題』。只算實質回應或解決了該問題；單純換話題、問別的事、給不相關內容都不算回答。只輸出被回答到的編號，用逗號分隔（例：0,2）；都沒有就輸出 none。不要任何解釋。",
      messages: [
        {
          role: "user",
          content: `待回答的問題：\n${list}\n\n使用者最新訊息：「${userMessage}」\n\n哪些編號被回答了？`,
        },
      ],
    });
    const text = (res.content?.[0]?.type === "text" ? res.content[0].text : "").trim();
    if (/none/i.test(text)) return [];
    return [...text.matchAll(/\d+/g)]
      .map((m) => Number(m[0]))
      .filter((n) => n >= 0 && n < pendingTexts.length);
  } catch (e) {
    console.error("classifyAnsweredQuestions 失敗：", e);
    return [];
  }
}

const LINE_MAX_CHARS = 4900;

// 現在時間（台北），讓 Claude 算得出相對日期
function nowContext() {
  const now = new Date();
  const human = new Intl.DateTimeFormat("zh-TW", {
    timeZone: TIME_ZONE,
    dateStyle: "full",
    timeStyle: "short",
    hour12: false,
  }).format(now);
  // 同時給機器好讀的 ISO（台北）
  const iso = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TIME_ZONE,
    dateStyle: "short",
    timeStyle: "medium",
  })
    .format(now)
    .replace(" ", "T");
  // 今天星期幾（台北）當錨點，讓 Claude 核對「日期 vs 星期」時往後數，少出錯
  const wd = new Intl.DateTimeFormat("zh-TW", {
    timeZone: TIME_ZONE,
    weekday: "long",
  }).format(now);
  return `現在時間（台灣時區 +08:00）：${human}（ISO: ${iso}+08:00）。今天是${wd}（算其他日期是星期幾時，以今天為錨點往後／往前數）。`;
}

// ── 待約會議清單 ───────────────────────────────────────────
// 資料來源是 Connectome 互動的 follow_up（follow_up_date／next_steps）。
// 全部待跟進都列，但 next_steps／summary 看起來像要約見面的標 📅 排在前面。
const MEETING_HINT_RE = /約|見面|碰面|面談|面聊|開會|會議|拜訪|約訪|約時間|聚|喝咖啡|meet/i;

function followupWhenLabel(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return "";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  if (diff < 0) return `逾期 ${-diff} 天`;
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  return `${diff} 天後`;
}

// 待約項目跟未來日曆事件比對：標題或與會者名字對得上某位參與者就算「已約進日曆」。
// events 已依開始時間排序，取最早一筆匹配的（最近一場已排的會）。
function eventMentionsPerson(ev, name) {
  if (!name) return false;
  const hay = `${ev.title || ""} ${(ev.attendees || []).map((a) => `${a.name || ""} ${a.email || ""}`).join(" ")}`;
  return hay.includes(name);
}

function findBookedEvent(participants, events) {
  const names = (participants || []).filter(Boolean);
  if (!names.length || !events.length) return null;
  return events.find((ev) => names.some((n) => eventMentionsPerson(ev, n))) || null;
}

function fmtEventWhen(ev) {
  const d = new Date(ev.start);
  if (isNaN(d)) return ev.start;
  return d.toLocaleString("zh-TW", {
    timeZone: TIME_ZONE,
    month: "numeric",
    day: "numeric",
    weekday: "short",
    ...(ev.allDay ? {} : { hour: "2-digit", minute: "2-digit", hour12: false }),
  });
}

function formatFollowupLine(it) {
  const who = (it.participants || []).join("、") || "（未連結對象）";
  const when = followupWhenLabel(it.follow_up_date);
  const what = it.next_steps || it.summary || "";
  let line = `・${who}${when ? `（${when}）` : ""}${what ? ` —— ${what}` : ""}\n　${it.follow_up_date}`;
  if (it.booked) {
    line += `\n　✅ 日曆已約：${fmtEventWhen(it.booked)}《${it.booked.title}》`;
  }
  return line;
}

async function buildPendingMeetingsText(days = 30) {
  if (!contactsConfigured) {
    return "人脈庫（Connectome）還沒設定好，沒辦法看待約清單。";
  }
  const items = await upcomingFollowups(days);
  if (!items.length) {
    return `目前沒有待約／待跟進的事（往後 ${days} 天內，含逾期）👍`;
  }

  // 日曆比對：抓未來 60 天事件，標出待約清單裡已經排進日曆的（日曆掛掉不影響清單本身）
  let events = [];
  if (calendarConfigured) {
    try {
      const now = new Date();
      const end = new Date(now);
      end.setDate(end.getDate() + 60);
      events = await listMyEvents({ start: now.toISOString(), end: end.toISOString() });
    } catch {
      events = [];
    }
  }

  const meetings = [];
  const others = [];
  for (const it of items) {
    const entry = { ...it, booked: findBookedEvent(it.participants, events) };
    const text = `${it.summary || ""} ${it.next_steps || ""}`;
    (MEETING_HINT_RE.test(text) ? meetings : others).push(entry);
  }
  const parts = [`📅 待約／待跟進（${items.length} 筆）：`];
  if (meetings.length) {
    parts.push("", "📅 像要約會議：", ...meetings.map(formatFollowupLine));
  }
  if (others.length) {
    parts.push("", "📌 其他待跟進：", ...others.map(formatFollowupLine));
  }
  return parts.join("\n");
}

// ── 指令處理 ───────────────────────────────────────────────
async function handleCommand(userId, text) {
  const trimmed = text.trim();

  // 「看待約」自然語捷徑：直接列清單（不用斜線、不耗 token）。
  // 注意：單講「待約」通常是「跟某人約下一個會」的意思，不在這裡攔截。
  if (/看待約/.test(trimmed)) {
    return buildPendingMeetingsText();
  }

  if (!trimmed.startsWith("/")) return null;

  const [cmd, ...rest] = trimmed.split(/\s+/);
  const arg = (rest[0] || "").toLowerCase();

  switch (cmd.toLowerCase()) {
    case "/model": {
      const current = MODELS[modelKeyFor(userId)];
      if (!arg) {
        const list = Object.entries(MODELS)
          .map(([k, m]) => `・/model ${k} → ${m.label}`)
          .join("\n");
        return `現在用的是 ${current.label}\n\n可切換：\n${list}`;
      }
      if (MODELS[arg]) {
        userModels.set(userId, arg);
        return `好，之後我用 ${MODELS[arg].label}`;
      }
      return `沒有「${arg}」這個模型。可選：${Object.keys(MODELS).join(" / ")}`;
    }

    case "/help":
      return [
        "🦞 77 能幫你：",
        "・📅 行程：查你今天/這週行程、訂會議室、查 SPACE 課表、建行程邀人",
        "・👥 人脈：找人/建檔/記互動/看該跟進的人（Connectome）",
        "・🧠 記憶：記你的偏好、存決策進知識庫",
        "・☑️ 待辦：新增/列出/完成（有到期日）",
        "・📨 主動推播：每日晨報、週回顧、會前背景、會後追蹤",
        "完整清單 👉 https://casper-assist.zeabur.app/help",
        "",
        "指令：",
        "・/meet — 待約會議清單（也可以直接說「看待約」）",
        "・/model — 看/切換模型（opus / sonnet / haiku）",
        "・/memory — 看我長期記住了哪些事",
        "・/sync — 重新整理人脈庫（Connectome）快取",
        "・/reset — 清空這次對話記憶（不影響長期記憶）",
        "",
        "小技巧：",
        "・直接傳名片照片，我辨識後確認再建進 Connectome 📇",
        "・拍白板／簡報，我整理成重點再問你要不要存 🧾",
        "・傳 PDF，我摘要重點（合約會特別抓錢和條款）📄",
        "・語音訊息也通，我轉文字後照常處理 🎤",
        "・說「我決定…」我把決策（含為什麼）存進 MyWiki 📚",
        "・說「提醒我…」「我有什麼待辦」可以管待辦清單 ☑️",
        "・我在等你回覆某件事時：回 later＝晚點再提醒（1 小時後）、pass＝略過不再提醒 ⏰",
      ].join("\n");

    case "/meet":
      return buildPendingMeetingsText();

    case "/sync": {
      if (!contactsConfigured) {
        return "人脈庫（Connectome）還沒設定好，無法同步。";
      }
      try {
        const n = await syncPeople();
        return `已同步 Connectome 聯絡人，目前 ${n} 位 ✅`;
      } catch (e) {
        return `同步失敗：${e.message}`;
      }
    }

    case "/memory": {
      if (!memoryConfigured) {
        return "長期記憶還沒設定好（缺試算表設定），晚點再說。";
      }
      const mems = await getMemories();
      if (!mems.length) {
        return "目前我還沒記住任何長期的事。你跟我說「記住…」、或我覺得重要時就會記下來。";
      }
      const list = mems
        .map(
          (m, i) =>
            `${i + 1}. ${m.category ? `【${m.category}】` : ""}${m.content}`
        )
        .join("\n");
      return `我目前記得這些：\n${list}\n\n想刪哪條就跟我說「忘記第 N 條」或「忘記…」。`;
    }

    case "/reset":
      histories.set(userId, []);
      hydrated.add(userId); // 視為已載入，之後不再從試算表拉回舊對話
      persistSession(userId); // 把試算表那份也清掉
      return "好，這次對話記憶清空了（長期記憶還在）👌";

    default:
      return null;
  }
}

/**
 * 給定使用者訊息，回傳 77 的回覆字串。
 */
export async function reply(userId, userText) {
  const commandReply = await handleCommand(userId, userText);
  if (commandReply !== null) return commandReply.slice(0, LINE_MAX_CHARS);

  return runAssistant(userId, userText);
}

/**
 * 使用者傳來圖片（名片、白板、照片等），交給 77 看圖回覆。
 */
export async function replyImage(userId, { base64, mediaType }) {
  return runAssistant(userId, [
    {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: base64 },
    },
    { type: "text", text: `（${ownerName()} 傳來一張圖片）` },
  ]);
}

/**
 * 使用者傳來 PDF 檔案，交給 77 讀內容回覆（Claude 原生支援 PDF document block）。
 */
export async function replyDocument(userId, { base64, fileName }) {
  return runAssistant(userId, [
    {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: base64 },
    },
    { type: "text", text: `（${ownerName()} 傳來檔案：${fileName}）` },
  ]);
}

// 共用核心：userContent 是字串（文字訊息）或 content block 陣列（含圖片）
async function runAssistant(userId, userContent) {
  // 重啟後第一次碰到這個人 → 先把存著的對話載回來（避免失憶）
  await ensureHydrated(userId);

  // 用歷史 + 這次訊息組出本地 messages（工具往返只在本次呼叫內進行，不污染長期記憶）
  const messages = [
    ...getHistory(userId),
    { role: "user", content: userContent },
  ];

  // 載入長期記憶（lazy，啟動後第一次才打 Sheets，之後走 RAM 快取）
  const memories = memoryConfigured ? await getMemories() : [];

  const model = MODELS[modelKeyFor(userId)].id;
  let finalText = "";
  let nudges = 0; // 防「只承諾不執行」：偵測到它說要做卻沒呼叫工具時，自動催它真的動手的次數
  const MAX_NUDGES = 2;

  // tool-use 迴圈：最多跑幾輪避免無限迴圈（多人行程要 日曆+event+多次 find_person/log_interaction）
  for (let i = 0; i < 15; i++) {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      thinking: { type: "disabled" },
      system: [
        { type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } },
        { type: "text", text: memoryPromptSection(memories) }, // 長期記憶，放在快取區塊之後
        { type: "text", text: nowContext() }, // 動態
      ],
      tools: buildTools(),
      messages,
    });

    if (response.stop_reason === "tool_use") {
      // 把 assistant 這輪（含 tool_use）放回 messages
      messages.push({ role: "assistant", content: response.content });

      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        let resultText;
        let isError = false;
        console.log(`🔧 tool: ${block.name} ${JSON.stringify(block.input)}`);
        try {
          resultText = await runTool(block.name, block.input, userId);
          console.log(`   ↳ ok: ${resultText.slice(0, 120)}`);
        } catch (err) {
          console.error("工具執行失敗：", err);
          resultText = `工具執行失敗：${err.message}`;
          isError = true;
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: resultText,
          is_error: isError,
        });
      }
      messages.push({ role: "user", content: toolResults });
      continue; // 再讓 Claude 根據工具結果產生最終回覆
    }

    // 沒有要用工具 → 取最終文字
    finalText = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    // 🛡 防「只承諾不執行」：偵測到它說「現在/我來…建/送/記/加…」這種要動手的話、
    // 卻沒呼叫任何工具就想結束回合 → 注入系統提醒，逼它下一輪真的呼叫工具（最多催 MAX_NUDGES 次）。
    const promisesAction =
      /(現在|這就|我這就|馬上|立刻|我來|我先|先|接下來|接著|稍後|讓我|我就|我幫你|幫你|這邊就)[^。\n]{0,15}(建(?!議)立?|建進|新增|送[一進出到過]?|記[下進一]?|加[進入]?|寫進|存[進入]?|處理|更新|登錄|劃掉|完成)/.test(
        finalText
      );
    // 排除「要不要我幫你…嗎？」這類詢問／提議（那是在問，不是承諾）
    const isOffer = /要不要|需要我幫|想不想|可以幫你[^。\n]{0,12}嗎|嗎？\s*$/.test(finalText);
    if (promisesAction && !isOffer && nudges < MAX_NUDGES) {
      nudges++;
      console.log(`🛡 偵測到只承諾不執行，第 ${nudges} 次催它動手`);
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: `（系統提醒，不是 ${ownerName()} 發話）你剛才表示要執行上述動作，但這一回合並沒有實際呼叫任何工具——等於還沒做。請『現在就』呼叫對應的工具把它做完，並只依工具真實回傳的結果回報。若其實不需要工具就能回答，請直接給最終答覆，不要再說「我來做／我這就做／現在送」之類的話。`,
      });
      continue;
    }

    break;
  }

  const safe = (finalText || "（77 一時語塞，再說一次好嗎？）").slice(
    0,
    LINE_MAX_CHARS
  );
  // 只把使用者原話 + 最終回覆存進短期記憶（保持乾淨）
  pushHistory(userId, "user", userContent);
  pushHistory(userId, "assistant", safe);
  persistSession(userId); // 背景寫回試算表，不擋回覆
  return safe;
}
