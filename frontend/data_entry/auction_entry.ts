// data_entry/auction_entry.ts
// Renders the auction pick control and board grid for Auction Mode + own data.
// Mirrors the draft board structure: pick control on top, grid below.

import { makeCustomSelect } from '../custom_select.js'
import { readRequiredIntInput, buildBoardTableShell } from '../helper_functions.js'
import { getPlayerResults } from '../app_state.js'
import { buildPlayerOption, makeMinimalPlayerDisplay } from '../player_display.js'
import { getTeamIdentitiesFromSidebar } from '../setting_collection/league_settings.js'
import { makeDebouncer } from '../api/session.js'
import { runEvaluate } from '../api/draft_and_auction_session.js'
import { getTeamLabel, makeTeamLabelInput, TEAM_LABELS_CHANGED } from './team_labels.js'
import { makeAutodraftToggle } from './autodraft_toggle.js'
import {
    AuctionConfig,
    getPicks, getTeamIdentitiesFromBoard, getNDrafters, getNPicks, getCashPerTeam, getConfigKey, getHistory,
    resetAuctionState, applyAuctionConfig,
    recordAuctionPick, undoLastAuctionPick, clearAllAuctionPicks,
    getNominatorIndex, isAuctionComplete,
} from './auction_state.js'
import {
    isAutopilotRunning,
    getPendingNomination,
    clearPendingNomination,
    stopAuctionAutopilot,
    fireAuctionAutopilot,
    submitManualBid,
    passManualBid,
    nominateAndBidManual,
    getCurrentSeatIndex,
    isAuctionAutodrafter,
    handleAuctionDrafterToggle,
    PendingNomination,
} from './auction_autodraft.js'

// ─── Module state ─────────────────────────────────────────────────────────────

const _auctionDebouncer = makeDebouncer(() => { runEvaluate().catch(err => console.error('Auction evaluate failed:', err)) })

let auctionListenerController: AbortController | null = null

/** Total auction dollars a drafter has spent across the board's picks. */
function sumSpentByDrafter(picks: ReturnType<typeof getPicks>, drafterIndex: number): number {
    return picks.reduce((sum, pickRow) => sum + (pickRow[drafterIndex]?.cost ?? 0), 0)
}

/** Maximum allowed single bid for a drafter according to league budget rules. */
function maxBidForDrafter(drafterIndex: number): number {
    const picks = getPicks()
    const spent = sumSpentByDrafter(picks, drafterIndex)
    const remainingCash = getCashPerTeam() - spent
    const emptySlots = picks.filter(r => r[drafterIndex] === null).length
    return Math.max(1, remainingCash - Math.max(0, emptySlots - 1))
}

const ROUND_W = 46   // fits the collapse arrow beside 'Round'
const TEAM_W  = 60

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Clears the auction board state. Call when the player pool changes (e.g. data source switch)
 * so picks referencing old player ids are not sent to the backend.
 * The next renderAuctionEntry call will reinitialise from current sidebar values.
 */
export function resetAuctionEntry(): void {
    resetAuctionState()
    clearPendingNomination()
    stopAuctionAutopilot()
    _auctionDebouncer?.cancel()
}

/** Renders the auction entry UI into the container. Resets state if sidebar config changed. */
export function renderAuctionEntry(container: HTMLElement): void {
    const cfg = readAuctionConfig()

    if (cfg.key !== getConfigKey()) {
        applyAuctionConfig(cfg)
        clearPendingNomination()
    }

    // Detach listeners from the previous render's custom selects so their
    // closures can be garbage-collected. See comment on auctionListenerController.
    auctionListenerController?.abort()
    auctionListenerController = new AbortController()

    container.innerHTML = ''
    container.append(buildPickControl(container))
    container.append(buildAuctionBoard(container))

    // Notify layout that the board changed so the G-score tab can refresh
    container.dispatchEvent(new CustomEvent('auction-board-change', { bubbles: true }))
    _auctionDebouncer?.fire()

    // Trigger autopilot if current nominator is an autodrafter and auction is active
    const nominator = getNominatorIndex()
    const isAutoNominator = isAuctionAutodrafter(nominator)
    if (isAutoNominator && !isAutopilotRunning() && !getPendingNomination() && !isAuctionComplete()) {
        setTimeout(() => {
            fireAuctionAutopilot(container, renderAuctionEntry)
        }, 0)
    }
}

// ─── Pick control ─────────────────────────────────────────────────────────────

/** Builds the auction pick control row: player + drafter + cost inputs, lock-in / undo / clear buttons. */
function buildPickControl(container: HTMLElement): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'auction-pick-control'

    const done            = isAuctionComplete()
    const pending         = getPendingNomination()
    const running         = isAutopilotRunning()
    const nominator       = getNominatorIndex()
    const nominatorLabel  = getTeamLabel(nominator)
    const isAutoNominator = isAuctionAutodrafter(nominator)

    const statusLabel = document.createElement('div')
    statusLabel.className = 'pick-control-label'
    if (done) {
        statusLabel.textContent = 'Auction complete'
    } else if (pending) {
        statusLabel.innerHTML = `<b>${getTeamLabel(pending.nominatorIndex)}</b> nominated <b>${pending.playerName}</b> - Current bid: <b>$${pending.currentBid}</b> by <b>${getTeamLabel(pending.highBidderIndex)}</b> (${pending.activeBidders.size} active bidders)`
    } else if (running) {
        statusLabel.textContent = `Running auction autopilot (${nominatorLabel} nominating)`
    } else {
        statusLabel.textContent = `Nomination: ${nominatorLabel}${isAutoNominator ? ' (Autodrafter)' : ''}`
    }
    wrap.append(statusLabel)

    if (running) {
        const row = document.createElement('div')
        row.className = 'pick-control-row'

        const indicator = document.createElement('div')
        indicator.className = 'eval-indicator evaluating autopilot-running-indicator'
        indicator.textContent = 'Running autopilot'
        row.append(indicator)

        const btns = document.createElement('div')
        btns.className = 'pick-control-buttons'

        const stopBtn = document.createElement('button')
        stopBtn.className = 'pick-btn'
        stopBtn.textContent = 'Stop autopilot'
        stopBtn.addEventListener('click', () => {
            stopAuctionAutopilot()
        })
        btns.append(stopBtn)

        row.append(btns)
        wrap.append(row)
        return wrap
    }

    if (pending && !done) {
        const row = document.createElement('div')
        row.className = 'pick-control-row auction-bidding-row'

        const turnDrafter = pending.turnIndex
        const turnLabel = getTeamLabel(turnDrafter)
        const userSeatIdx = getCurrentSeatIndex()
        const isUserTurn = turnDrafter === userSeatIdx
        const turnMaxBid = maxBidForDrafter(turnDrafter)
        const nextMinBid = pending.currentBid + 1
        const canAfford = turnMaxBid >= nextMinBid

        const info = document.createElement('div')
        info.className = 'auction-turn-indicator'
        info.textContent = isUserTurn
            ? `Your turn (${turnLabel}) to bid or pass`
            : `${turnLabel}'s turn to bid or pass`
        row.append(info)

        // 1. Quick +1 button: "Bid $(currentBid + 1)"
        const plusOneBtn = document.createElement('button')
        plusOneBtn.className = 'pick-btn pick-btn-nominate'
        plusOneBtn.textContent = `Bid $${nextMinBid}`
        plusOneBtn.title = canAfford
            ? `Increase current bid to $${nextMinBid} for ${turnLabel}`
            : `${turnLabel} cannot afford next bid (max allowable bid is $${turnMaxBid})`
        plusOneBtn.disabled = !canAfford
        plusOneBtn.addEventListener('click', () => {
            submitManualBid(container, renderAuctionEntry, nextMinBid, turnDrafter)
        })

        // 2. Custom bid input: for non-autobidders allowed to increase by more than 1
        const customBidInput = document.createElement('input')
        customBidInput.type        = 'number'
        customBidInput.min         = String(nextMinBid)
        customBidInput.max         = String(turnMaxBid)
        customBidInput.placeholder = `$ (${nextMinBid} - ${turnMaxBid})`
        customBidInput.className   = 'auction-bid-input'
        customBidInput.disabled    = !canAfford

        const customBidBtn = document.createElement('button')
        customBidBtn.className = 'pick-btn'
        customBidBtn.textContent = 'Bid custom'
        customBidBtn.disabled = !canAfford
        customBidBtn.addEventListener('click', () => {
            const val = parseFloat(customBidInput.value)
            if (isNaN(val) || val < nextMinBid || val > turnMaxBid) return
            submitManualBid(container, renderAuctionEntry, Math.floor(val), turnDrafter)
        })

        const btns = document.createElement('div')
        btns.className = 'pick-control-buttons'

        // 3. Pass button: permanently drops this drafter out of bidding for this player
        const passBtn = document.createElement('button')
        passBtn.className   = 'pick-btn'
        passBtn.textContent = 'Pass'
        passBtn.title       = `Pass for ${turnLabel} and no longer bid on this player`
        passBtn.disabled    = pending.highBidderIndex === turnDrafter
        passBtn.addEventListener('click', () => {
            passManualBid(container, renderAuctionEntry, turnDrafter)
        })

        // 4. Undo previous selection
        const undoBtn = document.createElement('button')
        undoBtn.className   = 'pick-btn'
        undoBtn.textContent = 'Undo'
        undoBtn.disabled    = getHistory().length === 0
        undoBtn.addEventListener('click', () => {
            clearPendingNomination()
            const undone = undoLastAuctionPick()
            if (undone) {
                renderAuctionEntry(container)
                _auctionDebouncer?.fire()
            }
        })

        btns.append(passBtn, undoBtn)
        row.append(plusOneBtn, customBidInput, customBidBtn, btns)
        wrap.append(row)
        return wrap
    }

    const row = document.createElement('div')
    row.className = 'pick-control-row'

    const currentPicks = getPicks()
    const pickedSet = new Set(currentPicks.flat().filter(Boolean).map(p => p!.playerId))
    const available = getPlayerResults()?.map(p => p.player_id).filter(playerId => !pickedSet.has(playerId)) ?? []
    const playerSel = makeCustomSelect(
        'auction-pick-player',
        [
            { value: '', label: '' },
            ...available.map(buildPlayerOption),
        ],
        undefined,
        undefined,
        auctionListenerController?.signal,
    )
    playerSel.element.style.width = '100%'
    const playerCol = makePickCol('Player', playerSel.element)
    playerCol.style.flex = '1'
    row.append(playerCol)

    const listAvailableTeamOptions = () => [{ value: '', label: '' }, ...getTeamIdentitiesFromBoard()
        .map((name, index) => ({ value: name, label: getTeamLabel(index), index }))
        .filter(({ index }) => currentPicks.some(pickRow => pickRow[index] === null))
        .map(({ value, label }) => ({ value, label }))]
    const teamSel = makeCustomSelect(
        'auction-pick-team',
        listAvailableTeamOptions(),
        undefined,
        undefined,
        auctionListenerController?.signal,
    )
    teamSel.element.style.width = '100%'
    document.addEventListener(TEAM_LABELS_CHANGED, () => teamSel.setOptions(listAvailableTeamOptions()),
                              { signal: auctionListenerController?.signal })
    const teamCol = makePickCol('Drafter', teamSel.element)
    teamCol.style.flex = '1'
    row.append(teamCol)

    const costInput = document.createElement('input')
    costInput.type        = 'number'
    costInput.min         = '1'
    costInput.placeholder = '$'
    costInput.className   = 'auction-cost-input'

    function updateCostOverBudget(): void {
        const max = parseFloat(costInput.max)
        const cost = parseFloat(costInput.value)
        costInput.classList.toggle('over-budget', !isNaN(max) && !isNaN(cost) && cost > max)
    }

    function updateCostMax(): void {
        const team = teamSel.getValue()
        if (team) {
            const drafterIndex = getTeamIdentitiesFromBoard().indexOf(team)
            costInput.max = String(maxBidForDrafter(drafterIndex))
        } else {
            costInput.removeAttribute('max')
        }
        updateCostOverBudget()
    }

    costInput.addEventListener('input', updateCostOverBudget)
    teamSel.element.addEventListener('change', updateCostMax)
    row.append(makePickCol('Cost', costInput))

    const btns = document.createElement('div')
    btns.className = 'pick-control-buttons'

    if (!done) {
        const anyAutodrafters = getTeamIdentitiesFromBoard().some((_, i) => isAuctionAutodrafter(i))

        if (anyAutodrafters) {
            const nominateBtn = document.createElement('button')
            nominateBtn.className   = 'pick-btn pick-btn-nominate'
            nominateBtn.textContent = 'Nominate & Bid'
            nominateBtn.title       = 'Nominate this player with opening bid'

            nominateBtn.addEventListener('click', () => {
                const chosen = playerSel.getValue()
                if (!chosen) return
                const chosenPlayerId = Number(chosen)
                if (Number.isNaN(chosenPlayerId)) return
                const costVal = parseFloat(costInput.value)
                const userMax = maxBidForDrafter(nominator)
                const userBid = (!isNaN(costVal) && costVal >= 1) ? Math.min(Math.floor(costVal), userMax) : 1
                nominateAndBidManual(container, renderAuctionEntry, chosenPlayerId, userBid)
            })
            btns.append(nominateBtn)
        }

        const lockBtn = document.createElement('button')
        lockBtn.className   = 'pick-btn'
        lockBtn.textContent = anyAutodrafters ? 'Manual lock-in' : 'Lock in selection'
        lockBtn.addEventListener('click', () => {
            const chosen = playerSel.getValue()
            if (!chosen) return
            const chosenPlayerId = Number(chosen)
            if (Number.isNaN(chosenPlayerId)) throw new Error(`Auction pick select carried a non-numeric value: "${chosen}"`)
            const team = teamSel.getValue()
            if (!team) return
            const drafterIndex = getTeamIdentitiesFromBoard().indexOf(team)
            const cost = parseFloat(costInput.value)
            if (isNaN(cost) || cost <= 0) return
            const spent = sumSpentByDrafter(getPicks(), drafterIndex)
            if (cost > getCashPerTeam() - spent) return
            const succeeded = recordAuctionPick(chosenPlayerId, cost, drafterIndex)
            if (succeeded) {
                renderAuctionEntry(container)
                _auctionDebouncer?.fire()
            }
        })
        btns.append(lockBtn)
    }

    const undoBtn = document.createElement('button')
    undoBtn.className   = 'pick-btn'
    undoBtn.textContent = 'Undo previous selection'
    undoBtn.disabled    = getHistory().length === 0
    undoBtn.addEventListener('click', () => {
        clearPendingNomination()
        const undone = undoLastAuctionPick()
        if (undone) {
            renderAuctionEntry(container)
            _auctionDebouncer?.fire()
        }
    })

    const clearBtn = document.createElement('button')
    clearBtn.className   = 'pick-btn'
    clearBtn.textContent = 'Clear auction board'
    clearBtn.addEventListener('click', () => {
        clearPendingNomination()
        stopAuctionAutopilot()
        const cleared = clearAllAuctionPicks()
        if (cleared) {
            renderAuctionEntry(container)
            runEvaluate().catch(err => console.error('Evaluate after clear failed:', err))
        }
    })

    btns.append(undoBtn, clearBtn)
    row.append(btns)
    wrap.append(row)
    return wrap
}

// ─── Auction board table ──────────────────────────────────────────────────────

/**
 * Builds the auction status badge displayed directly above each team column header.
 * Shows:
 * - Current bid (if placed a bid)
 * - 'Passed' (if drafter passed on this player)
 * - 'Not bid yet' (if active but hasn't placed a bid yet)
 * - '-' or 'Nominating' when no nomination is active
 */
function buildTeamAuctionStatus(
    drafterIndex: number,
    pending: PendingNomination | null,
    container: HTMLElement
): HTMLElement {
    const badge = document.createElement('div')
    badge.className = 'auction-team-bid-status'

    if (!pending) {
        const nominator = getNominatorIndex()
        if (!isAuctionComplete() && nominator === drafterIndex) {
            badge.classList.add('status-next-nominator')
            badge.textContent = 'Nominating'
            badge.title = `${getTeamLabel(drafterIndex)} nominates next`
        } else {
            badge.classList.add('status-idle')
            badge.textContent = '-'
        }
        return badge
    }

    const hasPassed = !pending.activeBidders.has(drafterIndex)
    const isHighBidder = pending.highBidderIndex === drafterIndex
    const lastBid = pending.lastBids?.[drafterIndex]
    const isTurn = pending.turnIndex === drafterIndex && !hasPassed && !isHighBidder

    if (isTurn) {
        badge.classList.add('is-turn')
    }

    if (hasPassed) {
        badge.classList.add('status-passed')
        badge.textContent = 'Passed'
        badge.title = `${getTeamLabel(drafterIndex)} passed on ${pending.playerName}`
    } else if (lastBid !== undefined && lastBid > 0) {
        if (isHighBidder) {
            badge.classList.add('status-high-bid')
            badge.textContent = `$${lastBid} High`
            badge.title = `${getTeamLabel(drafterIndex)} holds the high bid of $${lastBid}`
        } else {
            badge.classList.add('status-outbid')
            badge.textContent = `$${lastBid}`
            badge.title = `${getTeamLabel(drafterIndex)} bid $${lastBid} (currently outbid)`
        }
    } else {
        badge.classList.add('status-not-bid')
        badge.textContent = 'Not bid'
        badge.title = `${getTeamLabel(drafterIndex)} has not bid yet on ${pending.playerName}`
    }

    // If it is this manual drafter's turn to act, clicking their status badge also acts as Pass
    if (isTurn) {
        badge.style.cursor = 'pointer'
        badge.title = `Click to pass for ${getTeamLabel(drafterIndex)}`
        badge.addEventListener('click', () => {
            passManualBid(container, renderAuctionEntry, drafterIndex)
        })
    }

    return badge
}

/** Builds the auction board grid: rounds × drafters with player names, costs, and remaining budget footer. */
function buildAuctionBoard(container: HTMLElement): HTMLElement {
    const scroll = document.createElement('div')
    scroll.className = 'entry-table-scroll'

    const nPicks      = getNPicks()
    const nDrafters   = getNDrafters()
    const picks       = getPicks()
    const cashPerTeam = getCashPerTeam()
    const pending     = getPendingNomination()

    // Header columns follow nDrafters rather than the name list: board identities are
    // positional, so a half-edited textarea must not change the column count.
    const table = buildBoardTableShell(nDrafters, TEAM_W, ROUND_W, 'auction_board_open', d => {
        const cellWrap = document.createElement('div')
        cellWrap.className = 'auction-team-header-wrap'

        // UI above team: current bid, if passed, or if not bid yet
        cellWrap.append(buildTeamAuctionStatus(d, pending, container))

        const headerWrap = document.createElement('div')
        headerWrap.className = 'team-header'
        headerWrap.append(makeTeamLabelInput(d, auctionListenerController?.signal))
        headerWrap.append(makeAutodraftToggle(
            d,
            () => {
                handleAuctionDrafterToggle(d, container, renderAuctionEntry)
            },
            auctionListenerController?.signal,
            true,
            isAuctionAutodrafter,
        ))
        cellWrap.append(headerWrap)
        return cellWrap
    })

    // Body rows
    const tbody = table.createTBody()
    for (let r = 0; r < nPicks; r++) {
        const row = tbody.insertRow()

        const roundCell = row.insertCell()
        roundCell.className   = 'entry-cell-label'
        roundCell.textContent = String(r + 1)

        for (let d = 0; d < nDrafters; d++) {
            const cell = row.insertCell()
            const pick = picks[r][d]
            if (pick) {
                const costEl = document.createElement('div')
                costEl.className   = 'auction-cell-cost'
                costEl.textContent = `$${pick.cost}`

                cell.append(makeMinimalPlayerDisplay(pick.playerId), costEl)
                cell.classList.add('drafted')
            }
        }
    }

    // Footer: remaining budget per team
    const tfoot = table.createTFoot()
    const frow  = tfoot.insertRow()

    const budgetLabel = document.createElement('td')
    budgetLabel.className   = 'entry-cell-label auction-budget-label'
    budgetLabel.textContent = 'Remaining'
    frow.append(budgetLabel)

    for (let d = 0; d < nDrafters; d++) {
        const spent = sumSpentByDrafter(picks, d)
        const td = document.createElement('td')
        td.className   = 'auction-budget-cell'
        td.textContent = `$${cashPerTeam - spent}`
        frow.append(td)
    }

    scroll.append(table)
    return scroll
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Creates a labelled column wrapper for an input element in the pick control row. */
function makePickCol(labelText: string, input: HTMLElement): HTMLElement {
    const col = document.createElement('div')
    col.className = 'pick-col'
    const lbl = document.createElement('div')
    lbl.className   = 'pick-col-label'
    lbl.textContent = labelText
    col.append(lbl, input)
    return col
}

/** Reads current sidebar league settings and returns them with a composite key for change detection. */
function readAuctionConfig(): AuctionConfig {
    const nDrafters   = readRequiredIntInput('ls-n-drafters')
    const nPicks      = readRequiredIntInput('ls-n-picks')
    const cashPerTeam = readRequiredIntInput('ls-cash-per-team')
    const dataSource  = (document.getElementById('ps-data-type') as HTMLInputElement).value
    const teamNames   = getTeamIdentitiesFromSidebar()
    return {
        nDrafters
        , nPicks
        , cashPerTeam
        , teamNames
        , key: `${nDrafters}:${nPicks}:${cashPerTeam}:${dataSource}:${teamNames.join(',')}`
    }
}
