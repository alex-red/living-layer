import type { FastifyInstance } from 'fastify';
import {
  savesDeleteBodySchema,
  savesRenameBodySchema,
  savesSaveBodySchema,
} from '@livinglayer/domain';
import { LabError, parseInput } from './errors.js';
import type { RouteDeps } from './route-deps.js';

/**
 * Named saves, kept here so every browser and device on this server shares
 * them; each browser also keeps its own copy, for when the server can't be reached.
 */
export async function savesRoutes(app: FastifyInstance, { store }: Pick<RouteDeps, 'store'>) {
  app.get('', async () => store.listSaves());
  app.post('/save', async (request) => {
    const entry = parseInput(savesSaveBodySchema, request.body);
    const save = store.putSave(entry);
    return { save, saves: store.listSaves() };
  });
  app.post('/rename', async (request) => {
    const { id, name } = parseInput(savesRenameBodySchema, request.body);
    const done = store.renameSave(id, name);
    if (done === 'missing') throw new LabError('save_unknown', 'There is no such save.', 404);
    if (done === 'taken')
      throw new LabError('save_name_taken', `There is already a save called “${name}”.`, 409);
    return store.listSaves();
  });
  app.post('/delete', async (request) => {
    const { id } = parseInput(savesDeleteBodySchema, request.body);
    store.deleteSave(id);
    return store.listSaves();
  });
}
