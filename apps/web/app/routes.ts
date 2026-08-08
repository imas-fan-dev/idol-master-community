import type { RouteConfig, RouteConfigEntry } from "@react-router/dev/routes"

const publicRoutes = [
  { index: true, file: "pages/home/home-portal.tsx" },
  { path: "about", file: "pages/about/about-page.tsx" },
  { path: "events", file: "pages/events/events-center.tsx" },
  {
    path: "recommendations",
    file: "pages/recommendations/recommendations-center.tsx",
  },
  { path: "live", file: "pages/live/live-page.tsx" },
  { path: "community", file: "pages/community/community-page.tsx" },
  { path: "account/login", file: "pages/account/login/account-login-page.tsx" },
  {
    path: "account/register",
    file: "pages/account/register/account-register-page.tsx",
  },
  {
    path: "community/exchange",
    file: "pages/community/exchange/community-exchange-page.tsx",
  },
  {
    path: "community/exchange/me",
    file: "pages/community/exchange/me/community-exchange-me-page.tsx",
  },
  {
    path: "community/exchange/offices/:officeSlug",
    file: "pages/community/exchange/community-office-page.tsx",
  },
  {
    path: "community/cards",
    file: "pages/community/community-cards-page.tsx",
  },
  {
    path: "producer-map",
    file: "pages/producer-map/producer-map-page.tsx",
  },
  { path: "works", file: "pages/works/works-page.tsx" },
  {
    path: "works/:workSlug",
    file: "pages/works/work-detail-page.tsx",
  },
  {
    id: "pages/wiki/modern/wiki-index-default",
    path: "wiki",
    file: "pages/wiki/modern/wiki-index-page.tsx",
  },
  { path: "wiki/modern", file: "pages/wiki/modern/wiki-index-page.tsx" },
  {
    id: "pages/wiki/modern/story-default",
    path: "story",
    file: "pages/wiki/modern/story-page.tsx",
  },
  { path: "story/modern", file: "pages/wiki/modern/story-page.tsx" },
  {
    path: "information/:contentId",
    file: "pages/information/information-content-page.tsx",
  },
  {
    path: "chronicle",
    file: "pages/chronicle/chronicle-index-page.tsx",
  },
  {
    path: "chronicle/:activityId",
    file: "pages/chronicle/activity-page.tsx",
  },
  {
    path: "packages/:siteSlug",
    file: "pages/sites/site-detail-page.tsx",
  },
] satisfies RouteConfigEntry[]

const standaloneRoutes = [
  {
    path: "wiki/classic",
    file: "pages/wiki/classic/classic-wiki-page.tsx",
  },
  {
    path: "story/classic",
    file: "pages/wiki/classic/classic-story-page.tsx",
  },
  { path: "admin/login", file: "pages/admin/login/admin-login-page.tsx" },
] satisfies RouteConfigEntry[]

const adminRoutes = [
  { index: true, file: "pages/admin/index/admin-index-page.tsx" },
  { path: "events", file: "pages/admin/events/admin-events-page.tsx" },
  { path: "about", file: "pages/admin/about/about-manager.tsx" },
  {
    path: "homepage",
    file: "pages/admin/homepage/homepage-link-manager.tsx",
  },
  {
    path: "producer-map",
    file: "pages/admin/producer-map/producer-map-manager.tsx",
  },
  {
    path: "community/exchange",
    file: "pages/admin/community/exchange/admin-community-exchange-page.tsx",
  },
  {
    path: "information",
    file: "pages/admin/information/information-manager.tsx",
  },
  {
    path: "recommendations",
    file: "pages/admin/recommendations/recommendation-manager.tsx",
  },
  { path: "cards", file: "pages/admin/cards/admin-cards-page.tsx" },
  {
    path: "site-packages",
    file: "pages/admin/site-packages/site-package-manager.tsx",
  },
  {
    path: "stories/assets",
    file: "pages/admin/stories/story-cover-assets-page.tsx",
  },
  {
    path: "stories",
    file: "pages/admin/stories/story-management-page.tsx",
  },
  {
    path: "chronicle",
    file: "pages/admin/chronicle/admin-chronicle-page.tsx",
  },
  {
    path: "accounts",
    file: "pages/admin/accounts/admin-accounts-page.tsx",
  },
  { path: "*", file: "pages/admin/not-found/admin-not-found-page.tsx" },
] satisfies RouteConfigEntry[]

export default [
  { file: "layouts/public-layout.tsx", children: publicRoutes },
  ...standaloneRoutes,
  {
    path: "admin",
    file: "layouts/admin-layout.tsx",
    children: adminRoutes,
  },
] satisfies RouteConfig
