/**
 * Instagram lists (provider.lists.*).
 *
 * Lists are a cross-platform construct (a saved set of users) but each list
 * row carries a `platform` column so a TG list and an IG list with the
 * same name don't collide. The shared listService already accepts a
 * `platform` option; this module just always passes 'instagram'.
 */

const listService = require('../../services/listService');

async function createList(args = {}) {
  return listService.createList({ ...args, platform: 'instagram' });
}
async function listLists(userId, opts = {}) {
  return listService.listLists(userId, { ...opts, platform: 'instagram' });
}
async function getList(...args) { return listService.getList(...args); }
async function updateList(...args) { return listService.updateList(...args); }
async function deleteList(...args) { return listService.deleteList(...args); }
async function listItems(...args) { return listService.listItems(...args); }

module.exports = {
  createList,
  create: createList,
  listLists,
  list: listLists,
  getList,
  get: getList,
  updateList,
  update: updateList,
  deleteList,
  delete: deleteList,
  listItems,
  items: listItems,
};
