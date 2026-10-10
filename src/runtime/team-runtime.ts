import { InboxStore } from '../storage/inbox-store.ts';
import { LeaseStore } from '../storage/lease-store.ts';
import { TeamPaths } from '../storage/paths.ts';
import { ReceiptStore } from '../storage/receipt-store.ts';
import { TeamStore } from '../storage/team-store.ts';
import { DeliveryService } from './delivery.ts';
import { MembershipService } from './membership.ts';
import { PresenceService } from './presence.ts';
import { TeamReconciler } from './reconciler.ts';
import { RequestService } from './requests.ts';
import { ResourceLeaseService } from './resources.ts';

/** Shared Team v2 services for one extension instance. No background work starts here. */
export class TeamRuntime {
  readonly paths: TeamPaths;
  readonly teams: TeamStore;
  readonly inbox: InboxStore;
  readonly receipts: ReceiptStore;
  readonly leases: LeaseStore;
  readonly presence: PresenceService;
  readonly memberships: MembershipService;
  readonly delivery: DeliveryService;
  readonly requests: RequestService;
  readonly resources: ResourceLeaseService;
  readonly reconciler: TeamReconciler;

  constructor(paths = new TeamPaths(), now: () => number = Date.now) {
    this.paths = paths;
    this.teams = new TeamStore(paths);
    this.inbox = new InboxStore(paths, { now });
    this.receipts = new ReceiptStore(paths, { now });
    this.leases = new LeaseStore(paths, { now });
    this.presence = new PresenceService(this.teams, this.leases, { now });
    this.memberships = new MembershipService(paths, this.teams, this.presence, now);
    this.delivery = new DeliveryService(this.memberships, this.inbox, this.receipts, this.leases, { now });
    this.requests = new RequestService(
      paths, this.teams, this.memberships, this.delivery, this.inbox, this.receipts, now,
    );
    this.resources = new ResourceLeaseService(this.memberships, this.leases, now);
    this.reconciler = new TeamReconciler(
      paths, this.teams, this.inbox, this.receipts, this.presence, this.delivery, this.requests, now,
    );
  }
}
