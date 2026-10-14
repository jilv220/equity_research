import { Schema, pipe } from 'effect'
import { Route } from 'foldkit'
import { defineRouteUnion, literal, slash, string } from 'foldkit/route'

export const AppRoute = defineRouteUnion({
  Home: {},
  Company: { ticker: Schema.String },
  NotFound: { path: Schema.String },
})
export type AppRoute = typeof AppRoute.Type

export const homeRouter = pipe(Route.root, Route.mapTo(AppRoute.Home))

export const companyRouter = pipe(
  literal('t'),
  slash(string('ticker')),
  Route.mapTo(AppRoute.Company),
)

export const urlToAppRoute = Route.parseUrlWithFallback(
  Route.oneOf(companyRouter, homeRouter),
  AppRoute.NotFound,
)
