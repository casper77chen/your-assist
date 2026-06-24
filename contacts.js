// 人脈能力的 adapter 介面層（FRAMEWORK.md M4）。
//
// 框架原則：上層（assistant.js / system-prompt.js / briefing / meetwatch / weekly）只依賴
// 這個「contacts 介面」，不直接 import 任何特定 CRM。要換人脈庫，只改這一個檔。
//
// 目前唯一實作：Connectome（connectome.js）。未來要接別的 CRM：
//   1) 新增一個 provider 模組，實作下面 PROVIDERS 裡那組函式。
//   2) 在 PROVIDERS 註冊它，用環境變數 CONTACTS_PROVIDER 選用。
// 上層程式完全不用動。
//
// 註：Connectome 專屬的「管理操作」（dedupe / merge / ping 等）仍由 index.js 的 setup 路由
// 直接用 connectome.js——那是 provider 專屬維運工具，不屬於通用人脈能力介面。
import * as connectome from "./connectome.js";

const PROVIDER = (process.env.CONTACTS_PROVIDER || "connectome").toLowerCase();

const PROVIDERS = {
  connectome: {
    name: "Connectome",
    configured: connectome.connectomeConfigured,
    api: {
      findPeople: connectome.findPeople,
      createPerson: connectome.createPerson,
      updatePerson: connectome.updatePerson,
      createInteraction: connectome.createInteraction,
      createEvent: connectome.createEvent,
      upcomingFollowups: connectome.upcomingFollowups,
      createRelationship: connectome.createRelationship,
      tagPerson: connectome.tagPerson,
      addPersonToOrganization: connectome.addPersonToOrganization,
      syncPeople: connectome.syncPeople,
      getPeople: connectome.getPeople,
      getInteractions: connectome.getInteractions,
    },
  },
};

const active = PROVIDERS[PROVIDER] || PROVIDERS.connectome;

// ── 介面：能力旗標 + provider 顯示名 ──────────────────────
export const contactsConfigured = active.configured;
export const contactsProvider = active.name;

// ── 介面：人脈操作（名稱保持穩定，上層只認這些）──────────────
export const findPeople = active.api.findPeople;
export const createPerson = active.api.createPerson;
export const updatePerson = active.api.updatePerson;
export const createInteraction = active.api.createInteraction;
export const createEvent = active.api.createEvent;
export const upcomingFollowups = active.api.upcomingFollowups;
export const createRelationship = active.api.createRelationship;
export const tagPerson = active.api.tagPerson;
export const addPersonToOrganization = active.api.addPersonToOrganization;
export const syncPeople = active.api.syncPeople;
export const getPeople = active.api.getPeople;
export const getInteractions = active.api.getInteractions;
