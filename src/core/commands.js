// Command routing: a fixed switch from request type to the owning domain function.
// No registry. Handlers mutate only the candidate and return {kind, message, changes}.
import { CommandError, isSafeId } from './shape.js';
import { examine } from '../domain/knowledge.js';
import { depart, cancel, dock, undock } from '../domain/vessels.js';
import { permissionReason } from '../rules/authority.js';
import { moveToPlace } from '../domain/movement.js';
import { startWork, cancelWork, abortMachineRuns } from '../domain/work.js';
import { install, repair, setEnabled } from '../domain/equipment.js';
import { setOrder, stopOrder, recordAborts, orderOf } from '../domain/orders.js';
import { runExperiment, studyEquipment } from '../domain/research.js';
import { discard } from '../domain/inventory.js';

export function handle(candidate, request, ctx) {
  switch (request.type) {
    case 'examine':
      requireIds(request, ['targetId', 'placeId', 'subjectKey']);
      return examine(candidate, ctx, request);
    // Vessel commands: the player must hold `command` on the vessel. In Stage 3 content the
    // player commands no vessel; the Stage 6 drone uses this path.
    case 'departVessel':
      requireIds(request, ['vesselId', 'targetHostId']);
      requireCommand(candidate, ctx, request.vesselId);
      return depart(candidate, ctx, { vesselId: request.vesselId, targetHostId: request.targetHostId, dockOnArrival: request.dockOnArrival === true });
    case 'cancelJourney':
      requireIds(request, ['vesselId']);
      requireCommand(candidate, ctx, request.vesselId);
      return cancel(candidate, ctx, { vesselId: request.vesselId });
    case 'dockVessel':
      requireIds(request, ['vesselId']);
      requireCommand(candidate, ctx, request.vesselId);
      return dock(candidate, ctx, { vesselId: request.vesselId });
    case 'undockVessel':
      requireIds(request, ['vesselId']);
      requireCommand(candidate, ctx, request.vesselId);
      return undock(candidate, ctx, { vesselId: request.vesselId });
    // Stage 4: on-foot movement, personal work, research and cargo. Hands-on commands check
    // presence at the place where the work happens (L-02).
    case 'moveToPlace':
      requireIds(request, ['placeId']);
      return moveToPlace(candidate, ctx, { placeId: request.placeId });
    case 'startCollection':
      requireIds(request, ['itemId']);
      return startWork(candidate, ctx, { kind: 'collect', itemId: request.itemId });
    case 'startCraft':
      requireIds(request, ['recipeId']);
      return startWork(candidate, ctx, { kind: 'craft', recipeId: request.recipeId });
    case 'cancelWork':
      requireIds(request, ['runId']);
      return cancelWork(candidate, ctx, { runId: request.runId });
    case 'runExperiment':
      requireIds(request, ['methodId']);
      if (!Array.isArray(request.samples) || !request.samples.every(isSafeId)) throw new CommandError('The request is incomplete.', 'request');
      return runExperiment(candidate, ctx, { methodId: request.methodId, samples: [...request.samples] });
    // Stage 5: engineering studies name both the study and the machine (S-51).
    case 'studyEquipment':
      requireIds(request, ['studyId', 'bankId']);
      return studyEquipment(candidate, ctx, { studyId: request.studyId, bankId: request.bankId });
    // Industrial stage: instant installation and repair, machine control and orders.
    case 'installItem':
      requireIds(request, ['itemId']);
      return install(candidate, ctx, { itemId: request.itemId });
    case 'repairEquipment':
      requireIds(request, ['bankId']);
      return repair(candidate, ctx, { bankId: request.bankId });
    case 'setMachineEnabled':
      requireIds(request, ['bankId']);
      return setEnabled(candidate, ctx, { bankId: request.bankId, enabled: request.enabled });
    case 'setOrder':
      requireIds(request, ['bankId', 'processId']);
      return setOrder(candidate, ctx, { bankId: request.bankId, processId: request.processId, mode: request.mode, count: request.count });
    case 'stopOrder':
      requireIds(request, ['bankId']);
      return stopOrder(candidate, ctx, { bankId: request.bankId });
    case 'abortMachineRuns': {
      requireIds(request, ['bankId']);
      if (!Array.isArray(request.reviewed) || !request.reviewed.every(isSafeId)) throw new CommandError('The request is incomplete.', 'request');
      const result = abortMachineRuns(candidate, ctx, { bankId: request.bankId, reviewed: [...request.reviewed] });
      recordAborts(candidate, result.changes.aborted);   // aborted batches count against their order (S-45)
      // Abort means stop: the machine's order ends too, so its remaining batches are never started.
      const ord = orderOf(candidate, request.bankId);
      if (ord) {
        stopOrder(candidate, ctx, { bankId: request.bankId });
        result.message += ' The order was stopped.';
      }
      return result;
    }
    case 'discardCargo':
      requireIds(request, ['itemId']);
      return discard(candidate, ctx, { itemId: request.itemId, qty: request.qty, confirmed: request.confirmed === true });
    default:
      throw new CommandError('That action is not available.', 'request');
  }
}

function requireIds(request, fields) {
  for (const f of fields) if (!isSafeId(request[f])) throw new CommandError('The request is incomplete.', 'request');
}

function requireCommand(candidate, ctx, vesselId) {
  if (candidate.entities[vesselId]?.kind !== 'vessel') throw new CommandError('Unknown vessel.', 'request');
  const reason = permissionReason(candidate, ctx.actorId, vesselId, 'command');
  if (reason) throw new CommandError(reason.replace('here', 'over this vessel'), 'access');
}
