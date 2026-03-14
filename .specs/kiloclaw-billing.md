# KiloClaw Billing

## Status

Draft -- generated from branch `jdp/kiloclaw-billing` on 2026-03-13.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all
capitals, as shown here.

## Overview

KiloClaw Billing manages the subscription lifecycle for KiloClaw hosted
instances. Users access the service through one of three paths: a
time-limited free trial, a discounted six-month commit plan, or a
month-to-month standard plan. A legacy earlybird purchase also grants
access until a fixed expiry date. A periodic background job enforces
expiry, suspension, and eventual instance destruction when access lapses,
with email notifications at each stage.

## Rules

### Plans

1. The system MUST support exactly three subscription plans: trial,
   commit, and standard.
2. A trial plan MUST last 30 calendar days from the moment it is created.
3. A commit plan MUST cover a six-calendar-month billing period.
4. A standard plan MUST bill on a monthly recurring cycle.
5. The system MUST enforce at most one subscription record per user.
6. Plan pricing MUST be configured in the payment provider; the system
   MUST NOT independently validate or enforce specific price amounts.
7. The system MUST fail with an error at checkout time if a required
   plan price identifier is not configured.

### Trial Eligibility and Creation

1. The system MUST allow a user to start a trial only if the user has no
   existing subscription record and no existing instance record
   (including destroyed instances).
2. The system MUST reject a trial start request if the user already has a
   subscription record, regardless of that subscription's status.
3. When a trial is started, the system MUST record the trial start
   timestamp and an end timestamp exactly 30 days later.
4. The system MUST NOT require a credit card to start a trial.
5. When a user provisions an instance for the first time and has no
   subscription record, the system MUST automatically create a trial
   subscription. This path checks only for an existing subscription
   record (not instance records), but because user data deletion removes
   both subscription and instance records atomically, the two paths
   produce consistent outcomes.

### Access Control

1. The system MUST grant access when the subscription status is active.
2. The system MUST grant access when the subscription status is past-due
   and the subscription has not been suspended.
3. The system MUST grant access when the subscription status is trialing
   and the trial end date is in the future.
4. The system MUST grant access when the user holds a legacy earlybird
   purchase and the earlybird expiry date is in the future.
5. When earlybird access expires, the system MUST NOT automatically
   transition the user to a trial or any other plan; the user MUST
   manually subscribe to regain access.
6. The system MUST deny access and return a forbidden error when none of
   the above conditions are met.
7. All instance lifecycle operations (start, stop, destroy, provision,
   configuration changes) MUST be gated behind the access check, except
   for provisioning which uses the trial-bootstrap flow.

### Subscription Checkout

1. The system MUST reject a checkout request if the user already has a
   subscription in active, past-due, or unpaid status.
2. The system MUST allow checkout when the existing subscription status
   is trialing or canceled.
3. The system MUST verify with the payment provider that no subscription
   in active or trialing (delayed-billing) status already exists for the
   customer before creating a new checkout session, to guard against
   concurrent checkouts. This check does not cover provider-side
   subscriptions in past-due status.
4. The system MUST allow promotional codes only for the standard plan.
5. The system MUST NOT allow promotional codes for the commit plan.
6. When a configurable billing start date is set and is in the future,
   the system MUST create the subscription with a delayed billing period
   that begins on that date.
7. When the billing start date is unset or is in the past, the system
   MUST start billing immediately with no delayed period.
8. The system SHOULD include referral tracking data in checkout sessions
   when a referral cookie is present.

### Commit Plan Lifecycle

1. When a commit subscription is created, the system MUST create a
   payment provider schedule with phases: an optional delayed-billing
   phase, a six-month commit phase, and a standard-plan phase.
2. The system MUST derive the commit-period end date from the payment
   provider schedule's resolved phase boundaries, not from the
   subscription's current billing period.
3. The system MUST record a scheduled transition to the standard plan
   upon commit subscription creation.
4. If schedule creation fails, the system MUST roll back the entire
   subscription creation transaction so the payment provider can retry.
5. If a schedule already exists for the subscription (e.g., webhook
   replay), the system MUST skip schedule creation idempotently.
6. When the schedule completes, the system MUST update the local plan to
   the scheduled plan and clear the commit-period end date.
7. When the schedule is released or canceled (not completed), the system
   MUST clear the schedule tracking fields but MUST NOT change the
   current plan.

### Commit Renewal

1. The system MUST allow early renewal only for active commit
   subscriptions.
2. On renewal, the system MUST charge the user immediately via a
   one-off invoice.
3. On renewal, the system MUST extend the commit-period end date by
   exactly six calendar months from the current commit-period end.
4. On renewal, the system SHOULD update the payment provider schedule to
   reflect the new commit-period end date.
5. Renewal payment attempts MUST be idempotent for the same subscription
   and commit-period boundary.
6. If the renewal payment fails, the system MUST reject the request
   without modifying the commit-period end date.

### Plan Switching

1. The system MUST allow switching between commit and standard plans only
   for active subscriptions.
2. The system MUST reject a switch if the user is already on the
   requested plan.
3. A switch from standard to commit MUST create a schedule with three
   phases: current plan until period end, commit for six months,
   then standard.
4. A switch from commit to standard MUST create a schedule with two
   phases: current plan until period end, then standard.
5. For a standard-to-commit switch, the recorded scheduled-plan MUST
   be standard (the final plan after the full schedule completes), not
   commit.
6. The system MUST allow cancellation of user-initiated plan switches.
7. The system MUST NOT allow cancellation of the mandatory
   commit-to-standard auto-transition that is inherent to the commit
   plan.
8. The system MUST record whether each schedule was created
   automatically (auto-transition) or by a user action, so the
   cancellation guard can distinguish the two.

### Cancellation and Reactivation

1. The system MUST reject a cancellation request if no active
   subscription with a payment provider ID exists.
2. The system MUST reject a cancellation request if cancellation is
   already pending.
3. When canceling a subscription that has a pending schedule, the system
   MUST release the schedule before setting the cancel-at-period-end
   flag.
4. Cancellation MUST NOT terminate access immediately; access MUST
   continue until the current billing period ends.
5. The system MUST allow reactivation of a subscription that is pending
   cancellation.
6. On reactivation, the system MUST clear the cancel-at-period-end flag.
7. On reactivation of a commit subscription whose commit period has not
   yet elapsed, the system MUST recreate the commit-to-standard
   schedule. If schedule recreation fails, the system MUST roll back the
   reactivation (restore cancel-at-period-end) and return an error.
8. On reactivation of a commit subscription whose commit period has
   already elapsed, the system MUST NOT attempt to recreate the
   schedule.

### Billing Lifecycle Background Job

1. The background job MUST be protected by an authorization secret;
   requests without valid authorization MUST receive an unauthorized
   response.
2. Each sweep in the background job MUST process users independently;
   a failure for one user MUST NOT prevent processing of other users.
3. All errors during sweep processing MUST be captured for monitoring.

### Trial Expiry Warnings

1. When a trial has 5 or fewer days remaining and has not been
   suspended, the system MUST send a trial-ending-soon notification.
2. When a trial has 1 or fewer days remaining, the system MUST send a
   more urgent trial-expires-tomorrow notification instead of the
   5-day notification.

### Earlybird Expiry Warnings

1. When the earlybird expiry date is 14 or fewer days away, the system
   MUST send a warning notification to earlybird users who do not have
   an active or trialing subscription.
2. When the earlybird expiry date is 1 or fewer days away, the system
   MUST send a more urgent expires-tomorrow notification.

### Trial Expiry Enforcement

1. When a trial's end date has passed and the subscription is still in
   trialing status (not yet suspended), the system MUST stop the user's
   instance.
2. The system MUST transition the subscription to canceled status.
3. The system MUST set a suspension timestamp and a destruction deadline
   7 days in the future.
4. The system MUST send a trial-suspended notification.
5. If the instance stop operation fails (e.g., no instance exists), the
   system MUST still proceed with the status transition.

### Subscription Period Expiry Enforcement

1. When a canceled subscription's billing period has ended and the
   subscription has not been suspended, the system MUST stop the user's
   instance.
2. The system MUST set a suspension timestamp and a destruction deadline
   7 days in the future.
3. The system MUST send a subscription-suspended notification.

### Destruction Warning

1. When a suspended subscription's destruction deadline is 2 or fewer
   days away, the system MUST send a destruction-warning notification.

### Instance Destruction

1. When a suspended subscription's destruction deadline has passed, the
   system MUST destroy the user's instance.
2. The system MUST mark all active instance records as destroyed.
3. The system MUST clear the destruction deadline after destruction.
4. The system MUST send an instance-destroyed notification.
5. If the destroy operation fails (e.g., no instance exists), the system
   MUST still proceed with the state transition.

### Past-Due Payment Enforcement

1. When a subscription has been in past-due status for more than 14 days
   and has not been suspended, the system MUST stop the user's instance.
2. The system MUST set a suspension timestamp and a destruction deadline
   7 days in the future.
3. The system MUST send a payment-suspended notification.
4. The 14-day threshold MUST be measured from the time the subscription
   first entered past-due status, not from the last database update.

### Email Notifications

1. Each notification type MUST be sent at most once per user per
   lifecycle event.
2. If a notification send fails, the system MUST allow the notification
   to be retried on the next background job run.
3. The system MUST prevent concurrent duplicate sends of the same
   notification to the same user.

### Auto-Resume on Payment Recovery

1. When a subscription transitions to active while the user is
   suspended, the system MUST attempt to start the user's instance.
2. If the instance start attempt fails, the system MUST log the failure
   but MUST still proceed with clearing the suspension state. The system
   does not retry the instance start.
3. The system MUST clear the suspension timestamp and destruction
   deadline.
4. The system MUST clear email log entries for suspension and destruction
   notifications so they can fire again in a future suspension cycle.
5. The system MUST NOT clear email log entries for trial or earlybird
   warning notifications, as those are one-time events.

### Payment Provider Status Mapping

1. When the payment provider reports a subscription as "trialing"
   (delayed billing), the system MUST map this to active status
   internally, since delayed billing is not a product-level trial.
2. When the payment provider reports "incomplete" or "paused" status,
   the system MUST map these to terminal statuses (unpaid or canceled
   respectively).

### Billing Status Reporting

1. The billing status response MUST include whether the user currently
   has access and the reason for that access (trial, subscription, or
   earlybird).
2. The system MUST report trial eligibility as true only when the user
   has no instance records at all (including destroyed instances).
3. The billing status MUST include trial data (start, end, days
   remaining, expired flag) when a trial exists or existed.
4. The billing status MUST include subscription data (plan, status,
   cancel-at-period-end, period end, commit end, scheduled plan) when a
   paid subscription exists.
5. The billing status MUST include earlybird data (expiry date, days
   remaining) when the user has an earlybird purchase.
6. The billing status MUST include instance data (whether an
   undestroyed instance exists, suspension timestamp, destruction
   deadline, and destroyed flag) when any instance record exists.

### Billing Portal

1. The system MUST allow users to access the payment provider's billing
   portal to manage their payment methods.
2. The billing portal session MUST redirect the user back to the
   dashboard upon completion.

### User Data Deletion

1. When a user is soft-deleted, the system MUST delete all subscription
   records for that user.
2. When a user is soft-deleted, the system MUST delete all email
   notification log entries for that user.

## Error Handling

1. When a background job sweep encounters an error for a specific user,
   the system MUST log the error and continue processing remaining
   users.
2. When a commit schedule creation fails during subscription creation,
   the system MUST roll back the transaction and return an error to the
   payment provider so the webhook is retried.
3. When an instance stop or destroy operation fails during a lifecycle
   sweep, the system MUST log the failure and proceed with the
   subscription state transition regardless.
4. When a renewal payment fails, the system MUST return an error message
   directing the user to update their payment method.
5. When a schedule release fails during cancellation with an error
   indicating the schedule is already released or canceled, the system
   MUST treat this as success and proceed with clearing local state.
6. When a schedule release fails during cancellation for any other
   reason (e.g., transient API error), the system MUST abort the
   cancellation and return an error to the user.
