// data_entry/auction_autodraft.ts
// Orchestration for auction autodrafting: nomination rotation, ascending incremental bidding,
// permanent dropout on pass, and interactive manual turn escalation.

import { getSessionId, setAutopilotOn, setAutopilotOff } from '../api/session.js'
import { auctionAutodraft } from '../api/client.js'
import { getCurrentSeat } from '../app_state.js'
import { getAuctionDrafterMethod } from './drafter_methods.js'
import {
    recordAuctionPick,
    getNominatorIndex,
    isAuctionComplete,
    getAuctionState,
    getTeamIdentitiesFromBoard,
    getNDrafters,
    getPicks,
} from './auction_state.js'

export interface PendingNomination {
    playerId: number
    playerName: string
    nominatorIndex: number
    currentBid: number
    highBidderIndex: number
    activeBidders: Set<number>          // drafters who have not passed on this player
    valuations: Record<string, number>
    maxAllowedBids: Record<number, number>
    turnIndex: number                  // next drafter in order to bid
    bidHistory: Array<{ team: string; bid: number; action: string }>
    lastBids: Record<number, number>    // highest bid placed by each drafter on this player
}

// ─── Module state ─────────────────────────────────────────────────────────────

let _autopilotRunning = false
let _autopilotCancelled = false
let _pendingNomination: PendingNomination | null = null

export function isAutopilotRunning(): boolean {
    return _autopilotRunning
}

export function getPendingNomination(): PendingNomination | null {
    return _pendingNomination
}

export function clearPendingNomination(): void {
    _pendingNomination = null
}

export function stopAuctionAutopilot(): void {
    _autopilotCancelled = true
}

/** Returns the index of the manual user's seat (defaults to 0 if not found). */
export function getCurrentSeatIndex(): number {
    const seatName = getCurrentSeat()
    const identities = getTeamIdentitiesFromBoard()
    const idx = identities ? identities.indexOf(seatName ?? '') : -1
    return idx >= 0 ? idx : 0
}

/** Returns whether the given drafter index is configured as an auction autodrafter. */
export function isAuctionAutodrafter(drafterIndex: number): boolean {
    const userSeat = getCurrentSeatIndex()
    return getAuctionDrafterMethod(drafterIndex, userSeat) !== 'Manual input'
}

/**
 * Advances the active nomination through consecutive autobidders in set order.
 * Each autobidder raises by $1 if next bid <= valuation and next bid <= maxAllowedBid;
 * otherwise they pass and are permanently removed from activeBidders.
 * Stops when:
 * 1. Only 1 active bidder remains (or turn returns to highBidder) -> auction is complete (returns true).
 * 2. It is a manual drafter's turn to bid -> pauses for user action (returns false).
 */
export function advanceAutobidders(nom: PendingNomination): boolean {
    const nDrafters = getNDrafters()
    const teamIdentities = getTeamIdentitiesFromBoard()

    while (true) {
        // If 1 or 0 active bidders remain, the current high bidder wins
        if (nom.activeBidders.size <= 1) {
            return true
        }

        const currDrafter = nom.turnIndex

        // If this drafter already passed on this player, skip to next turn
        if (!nom.activeBidders.has(currDrafter)) {
            nom.turnIndex = (nom.turnIndex + 1) % nDrafters
            continue
        }

        // If turn cycles back to the current high bidder, all others passed in this cycle
        if (currDrafter === nom.highBidderIndex) {
            return true
        }

        const isAuto = isAuctionAutodrafter(currDrafter)

        // If it's a manual drafter's turn to bid, pause for user input
        if (!isAuto) {
            return false
        }

        // Autobidder's turn: raise by 1 or pass
        const teamName = teamIdentities[currDrafter] ?? `Team ${currDrafter + 1}`
        const val = nom.valuations[teamName] ?? nom.valuations[String(currDrafter)] ?? 0
        const maxAllowed = nom.maxAllowedBids[currDrafter] ?? 0
        const nextBid = nom.currentBid + 1

        if (nextBid <= val && nextBid <= maxAllowed) {
            nom.currentBid = nextBid
            nom.highBidderIndex = currDrafter
            nom.lastBids[currDrafter] = nextBid
            nom.bidHistory.push({ team: teamName, bid: nextBid, action: 'raise' })
        } else {
            // Otherwise they must pass and can no longer bid on this player
            nom.activeBidders.delete(currDrafter)
            nom.bidHistory.push({ team: teamName, bid: nom.currentBid, action: 'pass' })
        }

        nom.turnIndex = (nom.turnIndex + 1) % nDrafters
    }
}

/**
 * Runs the auction autopilot loop for consecutive autodrafter nominations.
 * Stops when:
 * - The auction is complete
 * - A manual drafter's nomination turn is reached
 * - An active nomination pauses for a manual drafter to bid or pass
 * - Autopilot is stopped by the user
 */
export async function fireAuctionAutopilot(
    container: HTMLElement,
    render: (c: HTMLElement) => void
): Promise<void> {
    if (_autopilotRunning) return
    const sessionId = getSessionId()
    if (!sessionId) return

    _autopilotRunning = true
    _autopilotCancelled = false
    setAutopilotOn()

    try {
        while (!isAuctionComplete() && !_autopilotCancelled) {
            const nominator = getNominatorIndex()
            const nominatorIsAuto = isAuctionAutodrafter(nominator)

            // If current nominator is manual, pause so user can nominate
            if (!nominatorIsAuto) {
                break
            }

            const teamIdentities = getTeamIdentitiesFromBoard()
            const nDrafters = getNDrafters()
            const picks = getPicks()
            const { player_assignments, remaining_cash } = getAuctionState()
            const autodrafterTeamIds = teamIdentities.filter((_, idx) => isAuctionAutodrafter(idx))

            // Fetch candidate and valuations from backend
            const result = await auctionAutodraft(sessionId, {
                player_assignments,
                remaining_cash,
                nominator_id: teamIdentities[nominator],
                autodrafter_team_ids: autodrafterTeamIds,
            })

            if (_autopilotCancelled) break

            // Compute max allowed bids for each drafter
            const maxAllowedBids: Record<number, number> = {}
            for (let d = 0; d < nDrafters; d++) {
                const emptySlots = picks.filter(r => r[d] === null).length
                const cash = remaining_cash[teamIdentities[d]] ?? 0
                maxAllowedBids[d] = Math.max(0, cash - (emptySlots - 1))
            }

            // Autobidder starting price is always 1
            const startPrice = 1
            const activeBidders = new Set<number>()
            for (let d = 0; d < nDrafters; d++) {
                if (maxAllowedBids[d] >= startPrice) {
                    activeBidders.add(d)
                }
            }
            activeBidders.add(nominator)

            const pending: PendingNomination = {
                playerId: result.nominated_player_id,
                playerName: result.nominated_player_name,
                nominatorIndex: nominator,
                currentBid: startPrice,
                highBidderIndex: nominator,
                activeBidders,
                valuations: result.valuations,
                maxAllowedBids,
                turnIndex: (nominator + 1) % nDrafters,
                bidHistory: [{ team: teamIdentities[nominator], bid: startPrice, action: 'nominate' }],
                lastBids: { [nominator]: startPrice },
            }

            const finished = advanceAutobidders(pending)

            if (!finished) {
                // Paused on manual drafter's turn
                _pendingNomination = pending
                break
            }

            // Finished: award player to high bidder
            recordAuctionPick(pending.playerId, pending.currentBid, pending.highBidderIndex)
            render(container)
        }
    } catch (err) {
        console.error('Auction autopilot failed:', err)
    } finally {
        _autopilotRunning = false
        setAutopilotOff()
        render(container)
    }
}

/**
 * Submits a manual bid on the active nomination.
 * Increases the current bid and advances autobidders until completion or next manual turn.
 */
export function submitManualBid(
    container: HTMLElement,
    render: (c: HTMLElement) => void,
    userBid: number,
    drafterIndex?: number
): void {
    if (!_pendingNomination) return
    const nom = _pendingNomination
    const activeIndex = drafterIndex ?? nom.turnIndex
    const teamIdentities = getTeamIdentitiesFromBoard()
    const teamName = teamIdentities[activeIndex] ?? `Team ${activeIndex + 1}`
    const maxAllowed = nom.maxAllowedBids[activeIndex] ?? 0

    // Cannot bid if already high bidder, or bid is not higher, or cannot afford
    if (nom.highBidderIndex === activeIndex || userBid <= nom.currentBid || userBid > maxAllowed) {
        return
    }

    nom.currentBid = userBid
    nom.highBidderIndex = activeIndex
    nom.lastBids[activeIndex] = userBid
    nom.bidHistory.push({ team: teamName, bid: userBid, action: 'raise' })
    nom.turnIndex = (activeIndex + 1) % getNDrafters()

    const finished = advanceAutobidders(nom)

    if (finished) {
        _pendingNomination = null
        recordAuctionPick(nom.playerId, nom.currentBid, nom.highBidderIndex)
        render(container)
        const nextNom = getNominatorIndex()
        if (!isAuctionComplete() && isAuctionAutodrafter(nextNom)) {
            fireAuctionAutopilot(container, render)
        }
    } else {
        render(container)
    }
}

/**
 * Passes on the active nomination.
 * Permanently removes drafter from active bidders for this player and advances autobidders.
 */
export function passManualBid(
    container: HTMLElement,
    render: (c: HTMLElement) => void,
    drafterIndex?: number
): void {
    if (!_pendingNomination) return
    const nom = _pendingNomination
    const activeIndex = drafterIndex ?? nom.turnIndex
    const teamIdentities = getTeamIdentitiesFromBoard()
    const teamName = teamIdentities[activeIndex] ?? `Team ${activeIndex + 1}`

    // A drafter holding the high bid cannot pass
    if (nom.highBidderIndex === activeIndex) {
        return
    }

    nom.activeBidders.delete(activeIndex)
    nom.bidHistory.push({ team: teamName, bid: nom.currentBid, action: 'pass' })
    nom.turnIndex = (activeIndex + 1) % getNDrafters()

    const finished = advanceAutobidders(nom)

    if (finished) {
        _pendingNomination = null
        recordAuctionPick(nom.playerId, nom.currentBid, nom.highBidderIndex)
        render(container)
        const nextNom = getNominatorIndex()
        if (!isAuctionComplete() && isAuctionAutodrafter(nextNom)) {
            fireAuctionAutopilot(container, render)
        }
    } else {
        render(container)
    }
}

/**
 * Resolves a nomination initiated by a manual drafter with an entered opening bid.
 * Advances autobidders in order; pauses if user is outbid and can raise, or completes.
 */
export async function nominateAndBidManual(
    container: HTMLElement,
    render: (c: HTMLElement) => void,
    playerId: number,
    openingBid: number = 1
): Promise<void> {
    const sessionId = getSessionId()
    if (!sessionId) return

    const nominator = getNominatorIndex()
    const teamIdentities = getTeamIdentitiesFromBoard()
    const nDrafters = getNDrafters()
    const picks = getPicks()
    const { player_assignments, remaining_cash } = getAuctionState()
    const autodrafterTeamIds = teamIdentities.filter((_, idx) => isAuctionAutodrafter(idx))

    try {
        const result = await auctionAutodraft(sessionId, {
            player_assignments,
            remaining_cash,
            nominator_id: teamIdentities[nominator],
            nominated_player_id: playerId,
            autodrafter_team_ids: autodrafterTeamIds,
            manual_bids: { [teamIdentities[nominator]]: openingBid },
        })

        const maxAllowedBids: Record<number, number> = {}
        for (let d = 0; d < nDrafters; d++) {
            const emptySlots = picks.filter(r => r[d] === null).length
            const cash = remaining_cash[teamIdentities[d]] ?? 0
            maxAllowedBids[d] = Math.max(0, cash - (emptySlots - 1))
        }

        const nomMax = maxAllowedBids[nominator] ?? 0
        const startPrice = Math.max(1, Math.min(openingBid, nomMax))
        const activeBidders = new Set<number>()
        for (let d = 0; d < nDrafters; d++) {
            if (maxAllowedBids[d] >= startPrice) {
                activeBidders.add(d)
            }
        }
        activeBidders.add(nominator)

        const pending: PendingNomination = {
            playerId,
            playerName: result.nominated_player_name,
            nominatorIndex: nominator,
            currentBid: startPrice,
            highBidderIndex: nominator,
            activeBidders,
            valuations: result.valuations,
            maxAllowedBids,
            turnIndex: (nominator + 1) % nDrafters,
            bidHistory: [{ team: teamIdentities[nominator], bid: startPrice, action: 'nominate' }],
            lastBids: { [nominator]: startPrice },
        }

        const finished = advanceAutobidders(pending)

        if (finished) {
            _pendingNomination = null
            recordAuctionPick(pending.playerId, pending.currentBid, pending.highBidderIndex)
            render(container)
            const nextNom = getNominatorIndex()
            if (!isAuctionComplete() && isAuctionAutodrafter(nextNom)) {
                fireAuctionAutopilot(container, render)
            }
        } else {
            _pendingNomination = pending
            render(container)
        }
    } catch (err) {
        console.error('Manual nominate & bid failed:', err)
        render(container)
    }
}

/**
 * Handles a drafter toggle between manual and auto in auction mode.
 * If a nomination is actively being bid on:
 * - If the drafter whose turn it currently is was just switched to auto, advances autobidders.
 * - Otherwise simply re-renders so the toggle state is updated without interrupting the active auction.
 * If no nomination is active:
 * - Re-renders, and triggers autopilot if the next nominator is an autodrafter.
 */
export function handleAuctionDrafterToggle(
    drafterIndex: number,
    container: HTMLElement,
    render: (c: HTMLElement) => void
): void {
    const pending = getPendingNomination()
    if (pending) {
        // An active nomination is in progress.
        const isAuto = isAuctionAutodrafter(drafterIndex)

        // If the drafter whose turn it currently is was switched to AUTO, advance the auction!
        if (isAuto && pending.turnIndex === drafterIndex) {
            const finished = advanceAutobidders(pending)
            if (finished) {
                clearPendingNomination()
                recordAuctionPick(pending.playerId, pending.currentBid, pending.highBidderIndex)
                render(container)
                const nextNom = getNominatorIndex()
                if (!isAuctionComplete() && isAuctionAutodrafter(nextNom)) {
                    fireAuctionAutopilot(container, render)
                }
                return
            }
        }
        render(container)
        return
    }

    // No active nomination in progress: re-render, and if next nominator is auto, fire autopilot
    render(container)
    const nominator = getNominatorIndex()
    if (!isAuctionComplete() && isAuctionAutodrafter(nominator) && !isAutopilotRunning()) {
        fireAuctionAutopilot(container, render)
    }
}
