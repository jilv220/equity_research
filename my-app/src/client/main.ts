import { Array, Duration, Effect, Match, Number, Option, Order, Record, Schema, String } from 'effect'
import { HttpClient } from 'effect/http'
import { AsyncData, Command, Http, Runtime, type Update } from 'foldkit'
import { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { UrlRequest, load, pushUrl } from 'foldkit/navigation'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { Url, toString as urlToString } from 'foldkit/url'

import {
  ErrorBody,
  Job,
  Metric,
  ScoreResponse,
  Scorecard,
  Section,
  Summary,
  Valuation,
  Watchlist,
  isJobActive,
} from './api'
import { AppRoute, urlToAppRoute } from './route'
import {
  type Breakdown,
  type Multiple,
  type SeriesKey,
  VALUATION_WINDOWS,
  type ValuationWindow,
  breakdown,
  valuationBand,
} from './valuation'

// MODEL

export const WatchlistAsyncData = AsyncData.Schema(Watchlist, Schema.String)
export const ValuationAsyncData = AsyncData.Schema(Valuation, Schema.String)

export const Company = defineTaggedUnion({
  NotSelected: {},
  Loading: { ticker: Schema.String },
  Loaded: {
    ticker: Schema.String,
    maybeCard: Schema.Option(Scorecard),
    maybeJob: Schema.Option(Job),
    pollCount: Schema.Number,
  },
  Failed: { ticker: Schema.String, error: Schema.String },
})
export type Company = typeof Company.Type

/**
 * What a score request asks the API for. `View` may be served from the edge cache; `Refresh` starts a
 * fresh job; `Poll` checks on a running job through a never-cached URL.
 */
export const ScoreQuery = defineTaggedUnion({
  View: {},
  Refresh: {},
  Poll: { jobId: Schema.String },
})
export type ScoreQuery = typeof ScoreQuery.Type

export const Model = Schema.Struct({
  route: AppRoute,
  tickerInput: Schema.String,
  watchlist: WatchlistAsyncData.schema,
  company: Company,
  expandedMetricIds: Schema.Array(Schema.String),
  // Identifies the current score request chain; results from an older chain are ignored.
  requestId: Schema.Number,
  valuation: ValuationAsyncData.schema,
  valuationWindow: Schema.Literals(VALUATION_WINDOWS),
  // Chart series the reader has toggled off in the legend.
  hiddenValuationSeries: Schema.Array(Schema.String),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedTickerInput: { value: Schema.String },
  SubmittedTickerForm: {},
  ClickedRefresh: {},
  ClickedMetric: { metricId: Schema.String },
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url },
  CompletedNavigateInternal: {},
  CompletedLoadExternal: {},
  CompletedScrollToTop: {},
  SucceededFetchScore: { requestId: Schema.Number, pollCount: Schema.Number, response: ScoreResponse },
  FailedFetchScore: { requestId: Schema.Number, ticker: Schema.String, error: Schema.String },
  CompletedWaitBeforePoll: { requestId: Schema.Number, ticker: Schema.String, jobId: Schema.String, pollCount: Schema.Number },
  SucceededFetchWatchlist: { rows: Watchlist },
  FailedFetchWatchlist: { error: Schema.String },
  SucceededFetchValuation: { ticker: Schema.String, valuation: Valuation },
  FailedFetchValuation: { ticker: Schema.String, error: Schema.String },
  ClickedValuationWindow: { window: Schema.Literals(VALUATION_WINDOWS) },
  ClickedValuationSeries: { series: Schema.String },
})
export type Message = typeof Message.Type

// COMMAND

const POLL_BASE_MS = 2000
const POLL_STEP_MS = 500
const POLL_MAX_MS = 6000

const normalizeTicker = (ticker: string) =>
  ticker.trim().toUpperCase().replace(/\./g, '-')

const errorMessage = (body: unknown, status: number) =>
  Option.match(Schema.decodeUnknownOption(ErrorBody)(body), {
    onNone: () => `Request failed (${status})`,
    onSome: ({ error }) => error,
  })

export const FetchScore = Command.define('FetchScore', {
  args: {
    ticker: Schema.String,
    query: ScoreQuery,
    requestId: Schema.Number,
    pollCount: Schema.Number,
  },
  messages: [Message.SucceededFetchScore, Message.FailedFetchScore],
  execute: ({ ticker, query, requestId, pollCount }) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const search = ScoreQuery.match<string>(query, {
        View: () => '',
        Refresh: () => '?refresh=1',
        Poll: ({ jobId }) => `?job=${encodeURIComponent(jobId)}`,
      })
      const response = yield* client.get(`/api/score/${encodeURIComponent(ticker)}${search}`)
      const body = yield* response.json

      if (response.status !== 200) {
        return Message.FailedFetchScore({ requestId, ticker, error: errorMessage(body, response.status) })
      }

      const decoded = yield* Schema.decodeUnknownEffect(ScoreResponse)(body)
      return Message.SucceededFetchScore({ requestId, pollCount, response: decoded })
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(Message.FailedFetchScore({ requestId, ticker, error: "Couldn't reach the scoring API." })),
      ),
      Effect.provide(Http.layer),
    ),
})

export const WaitBeforePoll = Command.define('WaitBeforePoll', {
  args: { requestId: Schema.Number, ticker: Schema.String, jobId: Schema.String, pollCount: Schema.Number },
  messages: [Message.CompletedWaitBeforePoll],
  execute: ({ requestId, ticker, jobId, pollCount }) =>
    Effect.sleep(Duration.millis(Math.min(POLL_BASE_MS + pollCount * POLL_STEP_MS, POLL_MAX_MS))).pipe(
      Effect.as(Message.CompletedWaitBeforePoll({ requestId, ticker, jobId, pollCount })),
    ),
})

export const FetchWatchlist = Command.define('FetchWatchlist', {
  messages: [Message.SucceededFetchWatchlist, Message.FailedFetchWatchlist],
  execute: Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get('/api/scores')
    const rows = yield* Schema.decodeUnknownEffect(Watchlist)(yield* response.json)
    return Message.SucceededFetchWatchlist({ rows })
  }).pipe(
    Effect.catch(() => Effect.succeed(Message.FailedFetchWatchlist({ error: "Couldn't load the watchlist." }))),
    Effect.provide(Http.layer),
  ),
})

export const FetchValuation = Command.define('FetchValuation', {
  args: { ticker: Schema.String },
  messages: [Message.SucceededFetchValuation, Message.FailedFetchValuation],
  execute: ({ ticker }) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.get(`/api/valuation/${encodeURIComponent(ticker)}`)
      const body = yield* response.json

      if (response.status !== 200) {
        return Message.FailedFetchValuation({ ticker, error: errorMessage(body, response.status) })
      }

      const valuation = yield* Schema.decodeUnknownEffect(Valuation)(body)
      return Message.SucceededFetchValuation({ ticker, valuation })
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(Message.FailedFetchValuation({ ticker, error: "Couldn't load the valuation history." })),
      ),
      Effect.provide(Http.layer),
    ),
})

export const NavigateInternal = Command.define('NavigateInternal', {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateInternal],
  execute: ({ url }) => pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal())),
})

const LoadExternal = Command.define('LoadExternal', {
  args: { href: Schema.String },
  messages: [Message.CompletedLoadExternal],
  execute: ({ href }) => load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
})

export const ScrollToTop = Command.define('ScrollToTop', {
  messages: [Message.CompletedScrollToTop],
  execute: Effect.sync(() => {
    window.scrollTo({ top: 0, behavior: 'instant' })
    return Message.CompletedScrollToTop()
  }),
})

// INIT

type UpdateReturn = Update.Return<Model, Message>

/** Starts a new score request chain for `ticker`, superseding any chain still polling. */
const startFetchScore = (model: Model, ticker: string, query: ScoreQuery, nextCompany: Company): UpdateReturn => {
  const nextRequestId = model.requestId + 1

  return {
    model: modifyFields(model, {
      company: () => nextCompany,
      requestId: () => nextRequestId,
    }),
    commands: [FetchScore({ ticker, query, requestId: nextRequestId, pollCount: 0 })],
  }
}

const enterRoute = (model: Model, route: AppRoute): UpdateReturn => {
  const routed = modifyFields(model, { route: () => route, expandedMetricIds: () => [] })

  const cleared: Model = modifyFields(routed, { valuation: () => ValuationAsyncData.Idle() })

  return AppRoute.match<UpdateReturn>(route, {
    Home: () => ({ model: modifyFields(cleared, { company: () => Company.NotSelected() }) }),
    NotFound: () => ({ model: modifyFields(cleared, { company: () => Company.NotSelected() }) }),
    Company: ({ ticker }) => {
      const nextTicker = normalizeTicker(ticker)
      const scoring = startFetchScore(
        modifyFields(cleared, { valuation: () => ValuationAsyncData.Loading() }),
        nextTicker,
        ScoreQuery.View(),
        Company.Loading({ ticker: nextTicker }),
      )
      return { model: scoring.model, commands: [...(scoring.commands ?? []), FetchValuation({ ticker: nextTicker })] }
    },
  })
}

export const init: Runtime.RoutingApplicationInit<Model, Message> = (url: Url) => {
  const initial: Model = {
    route: AppRoute.Home(),
    tickerInput: '',
    watchlist: WatchlistAsyncData.Loading(),
    company: Company.NotSelected(),
    expandedMetricIds: [],
    requestId: 0,
    valuation: ValuationAsyncData.Idle(),
    valuationWindow: '10Y',
    hiddenValuationSeries: ['pe', 'pb', 'ps'],
  }
  const entered = enterRoute(initial, urlToAppRoute(url))

  return { model: entered.model, commands: [FetchWatchlist(), ...(entered.commands ?? [])] }
}

// UPDATE

const currentTicker = (company: Company): Option.Option<string> =>
  Company.match<Option.Option<string>>(company, {
    NotSelected: () => Option.none(),
    Loading: ({ ticker }) => Option.some(ticker),
    Loaded: ({ ticker }) => Option.some(ticker),
    Failed: ({ ticker }) => Option.some(ticker),
  })

const loadedFromResponse = (response: ScoreResponse, pollCount: number): Company => {
  const { card, job } = response
  const failedWithoutCard = Option.isNone(card) && Option.exists(job, j => j.status === 'errored')

  if (failedWithoutCard) {
    return Company.Failed({
      ticker: response.ticker,
      error: Option.match(job, { onNone: () => 'Scoring failed', onSome: j => j.error ?? 'Scoring failed' }),
    })
  } else {
    return Company.Loaded({ ticker: response.ticker, maybeCard: card, maybeJob: job, pollCount })
  }
}

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    UpdatedTickerInput: ({ value }) => ({
      model: modifyFields(model, { tickerInput: () => value }),
    }),

    SubmittedTickerForm: () => {
      const ticker = normalizeTicker(model.tickerInput)

      if (String.isEmpty(ticker)) {
        return { model }
      } else {
        return {
          model: modifyFields(model, { tickerInput: () => '' }),
          commands: [NavigateInternal({ url: `/t/${encodeURIComponent(ticker)}` })],
        }
      }
    },

    ClickedRefresh: () =>
      Option.match(currentTicker(model.company), {
        onNone: () => ({ model }),
        onSome: ticker => startFetchScore(model, ticker, ScoreQuery.Refresh(), model.company),
      }),

    ClickedMetric: ({ metricId }) => ({
      model: modifyFields(model, {
        expandedMetricIds: ids =>
          Array.contains(ids, metricId) ? Array.filter(ids, id => id !== metricId) : Array.append(ids, metricId),
      }),
    }),

    ClickedLink: ({ request }) =>
      UrlRequest.match<UpdateReturn>(request, {
        Internal: ({ url }) => ({ model, commands: [NavigateInternal({ url: urlToString(url) })] }),
        External: ({ href }) => ({ model, commands: [LoadExternal({ href })] }),
      }),

    // A new page starts at the top; without this the scroll position carries over from the
    // previous company, e.g. after picking a ticker far down the watchlist.
    ChangedUrl: ({ url }) => {
      const routeEntered = enterRoute(model, urlToAppRoute(url))

      return { model: routeEntered.model, commands: [...(routeEntered.commands ?? []), ScrollToTop()] }
    },

    CompletedNavigateInternal: () => ({ model }),
    CompletedLoadExternal: () => ({ model }),
    CompletedScrollToTop: () => ({ model }),

    SucceededFetchScore: ({ requestId, pollCount, response }) => {
      if (requestId !== model.requestId) {
        return { model }
      }

      const nextCompany = loadedFromResponse(response, pollCount)
      const maybeRunningJob = Option.filter(response.job, isJobActive)
      const nextModel = modifyFields(model, { company: () => nextCompany })

      if (Option.isSome(maybeRunningJob)) {
        return {
          model: nextModel,
          commands: [WaitBeforePoll({ requestId, ticker: response.ticker, jobId: maybeRunningJob.value.id, pollCount })],
        }
      } else if (pollCount > 0) {
        // A background job just finished: the watchlist has a new or updated row, and the job also
        // rewrote the valuation history.
        return { model: nextModel, commands: [FetchWatchlist(), FetchValuation({ ticker: response.ticker })] }
      } else {
        return { model: nextModel }
      }
    },

    FailedFetchScore: ({ requestId, ticker, error }) => {
      if (requestId !== model.requestId) {
        return { model }
      } else {
        return { model: modifyFields(model, { company: () => Company.Failed({ ticker, error }) }) }
      }
    },

    CompletedWaitBeforePoll: ({ requestId, ticker, jobId, pollCount }) => {
      if (requestId !== model.requestId) {
        return { model }
      } else {
        return {
          model,
          commands: [FetchScore({ ticker, query: ScoreQuery.Poll({ jobId }), requestId, pollCount: pollCount + 1 })],
        }
      }
    },

    SucceededFetchWatchlist: ({ rows }) => ({
      model: modifyFields(model, { watchlist: () => WatchlistAsyncData.Success({ data: rows }) }),
    }),

    FailedFetchWatchlist: ({ error }) => ({
      model: modifyFields(model, { watchlist: () => WatchlistAsyncData.Failure({ error }) }),
    }),

    // Responses for a company the reader has since left are dropped.
    SucceededFetchValuation: ({ ticker, valuation }) =>
      Option.contains(currentTicker(model.company), ticker)
        ? { model: modifyFields(model, { valuation: () => ValuationAsyncData.Success({ data: valuation }) }) }
        : { model },

    FailedFetchValuation: ({ ticker, error }) =>
      Option.contains(currentTicker(model.company), ticker)
        ? { model: modifyFields(model, { valuation: () => ValuationAsyncData.Failure({ error }) }) }
        : { model },

    ClickedValuationWindow: ({ window }) => ({
      model: modifyFields(model, { valuationWindow: () => window }),
    }),

    ClickedValuationSeries: ({ series }) => ({
      model: modifyFields(model, {
        hiddenValuationSeries: hidden =>
          Array.contains(hidden, series) ? Array.filter(hidden, s => s !== series) : Array.append(hidden, series),
      }),
    }),
  })

// VIEW

const formatScore = (n: number) => globalThis.String(Math.round(n * 10) / 10)

const PANEL = 'rounded-xl border border-line bg-panel'
const LABEL = 'text-xs font-semibold uppercase tracking-wider text-muted'
const CELL = 'border-t border-line px-2.5 py-2 align-top'

const ratingTone = (rating: string) =>
  Match.value(rating).pipe(
    Match.when('Monopoly', () => 'bg-good-soft text-good'),
    Match.when('Strong moat', () => 'bg-accent-soft text-accent'),
    Match.when('Contested', () => 'bg-mid-soft text-mid'),
    Match.orElse(() => 'bg-bad-soft text-bad'),
  )

const pointsTone = (metric: Metric) =>
  metric.max === 0 ? 'bg-canvas text-muted' : Match.value(metric.points).pipe(
    Match.when(Number.isGreaterThanOrEqualTo(metric.max), () => 'bg-good-soft text-good'),
    Match.when(Number.isGreaterThan(0), () => 'bg-mid-soft text-mid'),
    Match.orElse(() => 'bg-bad-soft text-bad'),
  )

const selectedTicker = (model: Model): Option.Option<string> =>
  AppRoute.match<Option.Option<string>>(model.route, {
    Home: () => Option.none(),
    NotFound: () => Option.none(),
    Company: ({ ticker }) => Option.some(normalizeTicker(ticker)),
  })

const watchlistView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const maybeSelected = selectedTicker(model)
  const emptyRow = (text: string) => h.tr([], [h.td([h.Class('px-4 py-3 text-muted')], [text])])

  const rows = AsyncData.matchDataSplitEmpty(model.watchlist, {
    onIdle: () => [emptyRow('Loading…')],
    onLoading: () => [emptyRow('Loading…')],
    onFailure: error => [emptyRow(error)],
    onData: (summaries: ReadonlyArray<Summary>) =>
      Array.match(summaries, {
        onEmpty: () => [emptyRow('No companies scored yet.')],
        onNonEmpty: nonEmpty =>
          Array.map(sortWatchlist(nonEmpty), (summary, index) =>
            h.tr(
              [
                h.Key(summary.ticker),
                h.Class(
                  `hover:bg-accent-soft ${Option.contains(maybeSelected, summary.ticker) ? 'bg-accent-soft' : ''}`,
                ),
              ],
              [
                h.td([h.Class('w-7 border-t border-line py-1.5 pl-4 text-muted')], [globalThis.String(index + 1)]),
                h.td(
                  [h.Class('border-t border-line px-4 py-1.5')],
                  [
                    h.a(
                      [h.Href(`/t/${summary.ticker}`), h.Class('block')],
                      [
                        h.span([h.Class('font-mono font-semibold')], [summary.ticker]),
                        h.span([h.Class('block max-w-40 truncate text-xs text-muted')], [summary.name]),
                      ],
                    ),
                  ],
                ),
                h.td(
                  [h.Class('border-t border-line py-1.5 pr-4 text-right font-semibold tabular-nums')],
                  [summary.rating === 'Excluded' ? '—' : formatScore(summary.total)],
                ),
              ],
            ),
          ),
      }),
  })

  return h.aside(
    [h.Class('order-2 md:order-none')],
    [
      h.div(
        [h.Class(`${PANEL} py-1.5`)],
        [
          h.h2([h.Class(`${LABEL} mx-4 my-2.5`)], ['Ranked watchlist']),
          h.table([h.Class('w-full border-collapse')], [h.tbody([], rows)]),
        ],
      ),
    ],
  )
}

/** Score descending; ties broken by TTM ROIC (ground rule 7). */
const watchlistOrder: Order.Order<Summary> = Order.combine(
  Order.mapInput(Order.flip(Order.Number), (summary: Summary) => summary.total),
  Order.mapInput(Order.flip(Order.Number), (summary: Summary) => summary.ttmRoic ?? -Infinity),
)

const sortWatchlist = (rows: ReadonlyArray<Summary>): ReadonlyArray<Summary> => Array.sort(rows, watchlistOrder)

const notice = (h: HtmlBuilder<Message>, text: string): Html =>
  h.div([h.Class('mx-6 mt-4 rounded-lg bg-mid-soft px-3.5 py-2.5 text-[13px]')], [text])

const pill = (h: HtmlBuilder<Message>, text: string, tone: string): Html =>
  h.span([h.Class(`mt-2 inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone}`)], [text])

const cardHeadView = (card: Scorecard, isRefreshing: boolean, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-wrap items-start justify-between gap-6 border-b border-line px-6 py-5')],
    [
      h.div(
        [],
        [
          h.h2([h.Class('mb-1 text-[22px] font-semibold tracking-tight')], [`${card.ticker} · ${card.name}`]),
          h.div(
            [h.Class('text-[13px] text-muted')],
            [
              `SIC ${card.sic} ${card.sicDescription}`,
              h.br([]),
              `TTM to ${card.asOf} · latest FY ended ${card.latestFy} · computed ${new Date(card.computedAt).toLocaleString()}`,
            ],
          ),
          h.button(
            [
              h.Type('button'),
              h.Class(
                'mt-2.5 cursor-pointer rounded-lg border border-line px-3.5 py-2 font-medium text-accent hover:bg-accent-soft disabled:cursor-default disabled:opacity-55',
              ),
              h.Disabled(isRefreshing),
              h.OnClick(Message.ClickedRefresh()),
            ],
            [isRefreshing ? 'Refreshing…' : 'Refresh from EDGAR'],
          ),
        ],
      ),
      card.excluded === undefined
        ? h.div(
            [h.Class('sm:text-right')],
            [
              h.div(
                [h.Class('text-[44px] leading-none font-bold tracking-tight tabular-nums')],
                [formatScore(card.total), h.small([h.Class('text-lg font-medium text-muted')], [' / 100'])],
              ),
              pill(h, card.rating, ratingTone(card.rating)),
            ],
          )
        : h.div([h.Class('sm:text-right')], [pill(h, 'Excluded', ratingTone('Excluded'))]),
    ],
  )

const sectionSummaryView = (section: Section, h: HtmlBuilder<Message>): Html =>
  h.div(
    [],
    [
      h.div([h.Class('truncate text-xs text-muted')], [`${section.id}. ${section.name}`]),
      h.div([h.Class('font-semibold tabular-nums')], [`${formatScore(section.points)} / ${section.max}`]),
      h.div(
        [h.Class('mt-1 h-1.5 overflow-hidden rounded-full bg-track')],
        [
          h.i(
            [h.Class('block h-full bg-accent'), h.Style({ width: `${Math.round((100 * section.points) / section.max)}%` })],
            [],
          ),
        ],
      ),
    ],
  )

const sourceView = (source: string, h: HtmlBuilder<Message>): Html =>
  Option.match(Option.fromNullishOr(source.match(/https:\/\/\S+/)), {
    onNone: () => h.div([h.Class('mt-1')], [`Source: ${source}`]),
    onSome: match => {
      const href = match[0]
      return h.div(
        [h.Class('mt-1')],
        [
          `Source: ${source.slice(0, match.index)}`,
          h.a([h.Href(href), h.Target('_blank'), h.Rel('noopener'), h.Class('break-all text-accent underline')], [href]),
        ],
      )
    },
  })

const metricDetailView = (metric: Metric, h: HtmlBuilder<Message>): Html => {
  const inputs = Record.toEntries(metric.inputs)

  return h.tr(
    [h.Key(`${metric.id}-detail`)],
    [
      h.td(
        [h.Colspan(4), h.Class('border-t border-line bg-canvas py-2.5 pr-6 pl-14 text-[13px] wrap-anywhere')],
        [
          h.div([h.Class('mb-1.5 text-muted')], [metric.formula]),
          Array.isArrayNonEmpty(inputs)
            ? h.dl(
                [h.Class('my-1.5 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5')],
                Array.flatMap(inputs, ([label, value]) => [
                  h.dt([h.Class('text-muted')], [label]),
                  h.dd([h.Class('m-0 font-mono text-xs')], [value]),
                ]),
              )
            : h.empty,
          metric.note === undefined ? h.empty : h.div([h.Class('mt-1')], [metric.note]),
          metric.evidence === undefined
            ? h.empty
            : h.blockquote([h.Class('my-2 border-l-3 border-line px-2.5 py-1.5 text-xs text-muted')], [metric.evidence]),
          metric.source === undefined ? h.empty : sourceView(metric.source, h),
        ],
      ),
    ],
  )
}

const metricRowsView = (metric: Metric, isExpanded: boolean, h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
  h.tr(
    [
      h.Key(metric.id),
      h.Class(`cursor-pointer hover:bg-accent-soft ${isExpanded ? 'bg-accent-soft' : ''}`),
      h.OnClick(Message.ClickedMetric({ metricId: metric.id })),
      h.AriaExpanded(isExpanded),
    ],
    [
      h.td([h.Class(`${CELL} pl-6 font-mono text-muted`)], [metric.id]),
      h.td(
        [h.Class(CELL)],
        [
          h.div([h.Class('font-medium')], [metric.name]),
          h.div([h.Class('hidden text-xs whitespace-nowrap text-muted sm:block')], [metric.band]),
        ],
      ),
      h.td([h.Class(`${CELL} tabular-nums wrap-anywhere`)], [metric.display]),
      h.td(
        [h.Class(`${CELL} pr-6 text-right whitespace-nowrap`)],
        [
          h.span(
            [h.Class(`inline-block min-w-14 rounded-md px-2 py-0.5 text-center font-semibold tabular-nums ${pointsTone(metric)}`)],
            [`${formatScore(metric.points)} / ${metric.max}`],
          ),
        ],
      ),
    ],
  ),
  ...(isExpanded ? [metricDetailView(metric, h)] : []),
]

const sectionView = (section: Section, expandedMetricIds: ReadonlyArray<string>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('border-b border-line pt-2 pb-1 last:border-b-0')],
    [
      h.div(
        [h.Class(`${LABEL} mx-6 mt-2.5 mb-1.5 flex justify-between`)],
        [h.span([], [`${section.id}. ${section.name}`]), h.span([], [`${formatScore(section.points)} / ${section.max}`])],
      ),
      h.table(
        [h.Class('w-full table-fixed border-collapse')],
        [
          h.colgroup(
            [],
            [h.col([h.Class('w-14')]), h.col([]), h.col([h.Class('w-24 sm:w-36')]), h.col([h.Class('w-24 sm:w-28')])],
          ),
          h.tbody(
            [],
            Array.flatMap(section.metrics, metric =>
              metricRowsView(metric, Array.contains(expandedMetricIds, metric.id), h),
            ),
          ),
        ],
      ),
    ],
  )

const scorecardView = (
  card: Scorecard,
  maybeJob: Option.Option<Job>,
  pollCount: number,
  expandedMetricIds: ReadonlyArray<string>,
  h: HtmlBuilder<Message>,
): Html => {
  const isRefreshing = Option.exists(maybeJob, isJobActive)
  const jobNotice = Option.match(maybeJob, {
    onNone: () => h.empty,
    onSome: job =>
      Match.value(job).pipe(
        Match.when(isJobActive, () => notice(h, `Updating from SEC filings in the background (${job.status})…`)),
        Match.when(
          () => job.status === 'errored' && pollCount > 0,
          () => notice(h, `Refresh failed: ${job.error ?? 'unknown error'}. Showing the last score.`),
        ),
        Match.orElse(() => h.empty),
      ),
  })

  if (card.excluded !== undefined) {
    return h.div([h.Class('pb-5')], [cardHeadView(card, isRefreshing, h), jobNotice, notice(h, card.excluded)])
  } else {
    const gateNotice = card.gated
      ? notice(
          h,
          `Monopoly gate applied: TTM ROIC is ${card.ttmRoic === null ? 'not computable' : `${(card.ttmRoic * 100).toFixed(1)}%`} (below 8%), so the total is capped at 50. Uncapped sum: ${formatScore(card.rawTotal)}.`,
        )
      : h.empty

    return h.div(
      [],
      [
        cardHeadView(card, isRefreshing, h),
        jobNotice,
        gateNotice,
        h.div(
          [h.Class('grid grid-cols-3 gap-2 border-b border-line px-6 py-4 md:grid-cols-6')],
          Array.map(card.sections, section => sectionSummaryView(section, h)),
        ),
        ...Array.map(card.sections, section => sectionView(section, expandedMetricIds, h)),
      ],
    )
  }
}

const status = (h: HtmlBuilder<Message>, text: string, isError = false): Html =>
  h.div([h.Class(`px-6 py-10 ${isError ? 'text-bad' : 'text-muted'}`), h.AriaLive('polite')], [text])

const companyView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Company.match<Html>(model.company, {
    NotSelected: () =>
      AppRoute.match<Html>(model.route, {
        NotFound: ({ path }) => status(h, `No page at ${path}. Enter a ticker to score a company.`),
        Home: () =>
          status(
            h,
            'Enter a ticker to score it from its 10-K, 10-Q and proxy filings on SEC EDGAR. New companies are scored in the background (about a minute); the watchlist is re-scored nightly.',
          ),
        Company: () => h.empty,
      }),
    Loading: ({ ticker }) => status(h, `Loading ${ticker}…`),
    Failed: ({ error }) => status(h, error, true),
    Loaded: ({ ticker, maybeCard, maybeJob, pollCount }) =>
      Option.match(maybeCard, {
        onSome: card => scorecardView(card, maybeJob, pollCount, model.expandedMetricIds, h),
        onNone: () =>
          status(
            h,
            `Scoring ${ticker} from SEC filings in the background (${Option.match(maybeJob, { onNone: () => 'queued', onSome: job => job.status })}). Fetching and parsing a 10-K takes about 10–60 seconds; you can leave this page.`,
          ),
      }),
  })

// VALUATION

const TONE_TEXT = { good: 'text-good', muted: 'text-muted', mid: 'text-mid', bad: 'text-bad' } as const

const CHART_SERIES: ReadonlyArray<{ key: SeriesKey; label: string; stroke: string; ring: string }> = [
  { key: 'composite', label: 'Composite', stroke: 'stroke-accent', ring: 'border-accent' },
  { key: 'pe', label: 'P/E', stroke: 'stroke-good', ring: 'border-good' },
  { key: 'pb', label: 'P/B', stroke: 'stroke-mid', ring: 'border-mid' },
  { key: 'ps', label: 'P/S', stroke: 'stroke-bad', ring: 'border-bad' },
]

const MULTIPLE_TITLE: Record<Multiple, string> = { pe: 'P/E (TTM)', pb: 'P/B', ps: 'P/S (TTM)' }

const formatMonth = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })

const percentileCard = (
  h: HtmlBuilder<Message>,
  title: string,
  percentile: number | null,
  value: Option.Option<string>,
  unavailable: string,
): Html =>
  h.div(
    [h.Class('rounded-lg border border-line px-4 py-3')],
    percentile === null
      ? [
          h.div([h.Class(LABEL)], [title]),
          h.div([h.Class('mt-1 text-2xl font-semibold text-muted')], ['n/a']),
          ...Option.match(value, { onNone: () => [], onSome: v => [h.div([h.Class('tabular-nums text-muted')], [v])] }),
          h.div([h.Class('text-xs text-muted')], [unavailable]),
        ]
      : [
          h.div([h.Class(LABEL)], [title]),
          h.div(
            [h.Class(`mt-1 text-2xl font-semibold tabular-nums ${TONE_TEXT[valuationBand(percentile).tone]}`)],
            [`${percentile.toFixed(1)}%`],
          ),
          ...Option.match(value, { onNone: () => [], onSome: v => [h.div([h.Class('tabular-nums text-muted')], [v])] }),
          h.div([h.Class(`text-xs font-semibold ${TONE_TEXT[valuationBand(percentile).tone]}`)], [valuationBand(percentile).label]),
        ],
  )

const CHART = { width: 400, height: 220, left: 34, right: 6, top: 8, bottom: 20 }

const percentileChart = (b: Breakdown, hidden: ReadonlyArray<string>, h: HtmlBuilder<Message>): Html => {
  const n = b.chart.dates.length
  const plotWidth = CHART.width - CHART.left - CHART.right
  const plotHeight = CHART.height - CHART.top - CHART.bottom
  const x = (i: number) => CHART.left + (n <= 1 ? plotWidth : (i / (n - 1)) * plotWidth)
  const y = (p: number) => CHART.top + (1 - p / 100) * plotHeight

  const grid = Array.flatMap([0, 25, 50, 75, 100], p => [
    h.line([h.X1(`${CHART.left}`), h.X2(`${CHART.width - CHART.right}`), h.Y1(`${y(p)}`), h.Y2(`${y(p)}`), h.Class('stroke-line')], []),
    h.text(
      [h.X(`${CHART.left - 6}`), h.Y(`${y(p) + 3}`), h.TextAnchor('end'), h.Class('fill-muted text-[11px]')],
      [`${p}%`],
    ),
  ])

  const ticks = n === 0 ? [] : Array.dedupe([0, Math.floor((n - 1) / 2), n - 1])
  const xLabels = Array.map(ticks, (i, k) =>
    h.text(
      [
        h.X(`${x(i)}`),
        h.Y(`${CHART.height - 6}`),
        h.TextAnchor(k === 0 ? 'start' : k === ticks.length - 1 ? 'end' : 'middle'),
        h.Class('fill-muted text-[11px]'),
      ],
      [formatMonth(b.chart.dates[i]!)],
    ),
  )

  // One polyline per unbroken run, so gaps (not enough history, negative earnings) stay gaps.
  const lines = Array.flatMap(
    CHART_SERIES.filter(s => !Array.contains(hidden, s.key)),
    s => {
      const runs: string[][] = [[]]
      b.chart.series[s.key].forEach((p, i) => {
        if (p === null) runs.push([])
        else runs[runs.length - 1]!.push(`${x(i).toFixed(1)},${y(p).toFixed(1)}`)
      })
      return runs
        .filter(run => run.length > 1)
        .map(run =>
          h.polyline(
            [h.Points(run.join(' ')), h.Fill('none'), h.StrokeWidth('1.5'), h.StrokeLinejoin('round'), h.Class(s.stroke)],
            [],
          ),
        )
    },
  )

  return h.svg(
    [
      h.ViewBox(`0 0 ${CHART.width} ${CHART.height}`),
      h.Class('h-auto w-full'),
      h.Role('img'),
      h.AriaLabel('Valuation percentile over time (0 = cheapest, 100 = most expensive)'),
    ],
    [...grid, ...xLabels, ...lines],
  )
}

const valuationBody = (valuation: Valuation, model: Model, h: HtmlBuilder<Message>): Html => {
  const b = breakdown(valuation, model.valuationWindow)
  if (b === null) return h.p([h.Class('text-muted')], ['No price history available.'])

  const windowButtons = h.div(
    [h.Class('flex flex-wrap gap-2'), h.Role('group'), h.AriaLabel('Lookback window')],
    Array.map(VALUATION_WINDOWS, window =>
      h.button(
        [
          h.Type('button'),
          h.AriaPressed(globalThis.String(window === model.valuationWindow)),
          h.OnClick(Message.ClickedValuationWindow({ window })),
          h.Class(
            `cursor-pointer rounded-lg border px-3 py-1.5 font-semibold ${window === model.valuationWindow ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-ink'}`,
          ),
        ],
        [window],
      ),
    ),
  )

  const multipleCard = (m: Multiple) => {
    const r = b.readings[m]
    return percentileCard(
      h,
      MULTIPLE_TITLE[m],
      r.percentile,
      r.value === null ? Option.none() : Option.some(r.value.toFixed(2)),
      r.value === null ? 'Not meaningful (≤ 0)' : 'Not enough history',
    )
  }

  const legend = h.div(
    [h.Class('flex flex-wrap gap-x-4 gap-y-2')],
    Array.map(CHART_SERIES, s => {
      const isHidden = Array.contains(model.hiddenValuationSeries, s.key)
      return h.button(
        [
          h.Type('button'),
          h.AriaPressed(globalThis.String(!isHidden)),
          h.OnClick(Message.ClickedValuationSeries({ series: s.key })),
          h.Class(`flex cursor-pointer items-center gap-1.5 ${isHidden ? 'text-muted line-through' : 'text-ink'}`),
        ],
        [h.span([h.Class(`inline-block size-3 rounded-full border-2 ${s.ring}`)], []), `${s.label} percentile`],
      )
    }),
  )

  return h.div(
    [h.Class('grid gap-4')],
    [
      windowButtons,
      h.div(
        [h.Class('grid grid-cols-2 gap-3 md:grid-cols-4')],
        [
          percentileCard(h, 'Composite', b.composite, Option.none(), 'Not enough history'),
          multipleCard('pe'),
          multipleCard('pb'),
          multipleCard('ps'),
        ],
      ),
      legend,
      percentileChart(b, model.hiddenValuationSeries, h),
      h.p([h.Class('m-0 text-xs text-muted')], [`Prices through ${b.asOf}. ${valuation.notes.join(' ')}`]),
    ],
  )
}

const valuationView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const showsCard = Company.match<boolean>(model.company, {
    NotSelected: () => false,
    Loading: () => false,
    Failed: () => false,
    Loaded: ({ maybeCard }) => Option.exists(maybeCard, card => card.excluded === undefined),
  })
  if (!showsCard) return h.empty

  const body = AsyncData.matchDataSplitEmpty(model.valuation, {
    onIdle: () => h.p([h.Class('text-muted')], ['Loading valuation history…']),
    onLoading: () => h.p([h.Class('text-muted')], ['Loading valuation history…']),
    onFailure: (error: string) => h.p([h.Class('text-muted')], [error]),
    onData: (valuation: Valuation) => valuationBody(valuation, model, h),
  })

  return h.section(
    [h.Class(`${PANEL} mt-6 px-6 py-5`), h.AriaLabel('Valuation')],
    [
      h.h2([h.Class('mb-1 text-lg font-semibold tracking-tight')], ['Valuation vs. own history']),
      h.p(
        [h.Class('mt-0 mb-4 text-muted')],
        [
          "Where today's multiples sit within this stock's own history over the chosen window: 0% = the cheapest it has been, 100% = the most expensive. The composite averages whichever of P/E, P/B and P/S have enough history. Informational only; it doesn't affect the score.",
        ],
      ),
      body,
    ],
  )
}

const METHODOLOGY: ReadonlyArray<string> = [
  'GAAP figures from 10-K, 10-Q and DEF 14A filings via SEC EDGAR XBRL. TTM = latest FY + current YTD − prior-year YTD (equal to the last four quarters).',
  'Missing history scores 0. Tax rate 21%, hurdle 12%. Banks, broker-dealers, insurers and REITs are excluded by SIC code. Exchanges: B4 is not applicable, and the total is rescaled to 100 over the remaining metrics.',
  'Thresholds: "≥" bands include the lower bound; "≤ / >" bands (A4, B4, E3, F2, C2, C3) include the upper bound, as the table writes them.',
  'Invested capital = total debt (long-term incl. current portion, short-term borrowings, commercial paper; leases excluded) + total equity incl. NCI − cash & short-term investments; filers that tag debt only in the 10-K carry that balance forward up to a year. Average invested capital ≤ 0 → ROIC not meaningful → 0 points and the gate applies.',
  'Operating income: OperatingIncomeLoss when tagged; otherwise pre-tax income − non-operating income, or pre-tax income + interest expense − interest income − other non-operating income (A1 notes when derived).',
  'A4 uses the population standard deviation. B1 scores 0 when revenue CAGR ≤ 0. EBITDA = operating income + D&A from the cash-flow statement. C3: net cash scores 5 even with negative EBITDA.',
  'E1, E2, C2 are machine-read from filing text and inline XBRL; each shows the passage it was read from. Untagged customer concentration found only in text scores 0 pending review.',
  'Monopoly gate: TTM ROIC below 8% (or not computable) caps the total at 50. Ties rank by TTM ROIC.',
  'Scores are computed by a background job and refreshed nightly (06:00 UTC) from the latest filings.',
]

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: Option.match(selectedTicker(model), {
    onNone: () => 'Monopoly Scorecard',
    onSome: ticker => `${ticker} · Monopoly Scorecard`,
  }),
  body: h.div(
    [],
    [
      h.header(
        [h.Class('sticky top-0 z-10 flex flex-wrap items-center justify-between gap-4 border-b border-line bg-panel px-4 py-3 md:px-6')],
        [
          h.h1(
            [h.Class('m-0 text-base font-semibold tracking-tight')],
            [h.a([h.Href('/')], ['Monopoly Scorecard']), h.span([h.Class('font-normal text-muted')], [' · strict, filings-only'])],
          ),
          h.form(
            [h.Class('flex gap-2'), h.OnSubmit(Message.SubmittedTickerForm())],
            [
              h.input([
                h.Type('text'),
                h.Class(
                  'w-44 rounded-lg border border-line bg-canvas px-2.5 py-2 text-base uppercase sm:text-sm focus:outline-2 focus:-outline-offset-1 focus:outline-accent',
                ),
                h.Value(model.tickerInput),
                h.Placeholder('Ticker, e.g. NVDA'),
                h.Autocomplete('off'),
                h.Spellcheck(false),
                h.AriaLabel('Ticker'),
                h.OnInput(value => Message.UpdatedTickerInput({ value })),
              ]),
              // Never disabled: a disabled default button blocks Enter-to-submit until the next render.
              h.button(
                [h.Type('submit'), h.Class('cursor-pointer rounded-lg bg-accent px-3.5 py-2 font-semibold text-white hover:opacity-90')],
                ['Score'],
              ),
            ],
          ),
        ],
      ),
      h.main(
        [h.Class('mx-auto grid max-w-7xl gap-6 p-4 md:grid-cols-[300px_minmax(0,1fr)] md:p-6')],
        [
          watchlistView(model, h),
          h.section(
            [h.Class('min-w-0')],
            [
              h.div([h.Class(PANEL)], [companyView(model, h)]),
              valuationView(model, h),
              h.details(
                [h.Class(`${PANEL} mt-6 px-6 pb-4`)],
                [
                  h.summary([h.Class('cursor-pointer py-3 font-semibold')], ['Methodology and interpretation rules']),
                  h.ul([h.Class('list-disc space-y-1 pl-5')], Array.map(METHODOLOGY, item => h.li([], [item]))),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  ),
})
