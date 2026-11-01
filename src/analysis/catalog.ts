import type { Ecosystem } from "./manifests.js";

export type Category =
  | "ui_framework"
  | "meta_framework"
  | "backend_framework"
  | "state"
  | "styling"
  | "ui_kit"
  | "data_fetching"
  | "router"
  | "forms"
  | "orm"
  | "database"
  | "auth"
  | "validation"
  | "test_runner"
  | "e2e"
  | "queue"
  | "cache"
  | "api_style"
  | "build"
  | "logging"
  | "payment"
  | "email"
  | "storage"
  | "realtime"
  | "i18n"
  | "date"
  | "http_client"
  | "dnd"
  | "animation"
  | "icons"
  | "ai";

export interface Technology {
  name: string;
  category: Category;
  ecosystem: Ecosystem;
  packages: string[];
}

function group(category: Category, ecosystem: Ecosystem, entries: Record<string, string[]>): Technology[] {
  return Object.entries(entries).map(([name, packages]) => ({ name, category, ecosystem, packages }));
}

export const TECHNOLOGIES: Technology[] = [
  ...group("ui_framework", "npm", {
    react: ["react"],
    vue: ["vue"],
    svelte: ["svelte"],
    solid: ["solid-js"],
    angular: ["@angular/core"],
    preact: ["preact"],
    qwik: ["@builder.io/qwik"],
    lit: ["lit"],
  }),
  ...group("meta_framework", "npm", {
    next: ["next"],
    nuxt: ["nuxt"],
    sveltekit: ["@sveltejs/kit"],
    remix: ["@remix-run/react", "@remix-run/node"],
    "react-router-framework": ["@react-router/dev"],
    astro: ["astro"],
    gatsby: ["gatsby"],
    "tanstack-start": ["@tanstack/react-start"],
    expo: ["expo"],
  }),
  ...group("backend_framework", "npm", {
    express: ["express"],
    fastify: ["fastify"],
    nestjs: ["@nestjs/core"],
    hono: ["hono"],
    koa: ["koa"],
    hapi: ["@hapi/hapi"],
    elysia: ["elysia"],
    adonis: ["@adonisjs/core"],
  }),
  ...group("backend_framework", "pypi", {
    django: ["django"],
    flask: ["flask"],
    fastapi: ["fastapi"],
    starlette: ["starlette"],
    tornado: ["tornado"],
    sanic: ["sanic"],
    litestar: ["litestar"],
  }),
  ...group("backend_framework", "go", {
    gin: ["github.com/gin-gonic/gin"],
    echo: ["github.com/labstack/echo/v4"],
    fiber: ["github.com/gofiber/fiber/v2"],
    chi: ["github.com/go-chi/chi/v5"],
    gorilla: ["github.com/gorilla/mux"],
  }),
  ...group("backend_framework", "cargo", {
    axum: ["axum"],
    actix: ["actix-web"],
    rocket: ["rocket"],
    warp: ["warp"],
  }),
  ...group("backend_framework", "rubygems", { rails: ["rails"], sinatra: ["sinatra"] }),
  ...group("backend_framework", "packagist", {
    laravel: ["laravel/framework"],
    symfony: ["symfony/framework-bundle"],
  }),
  ...group("backend_framework", "maven", {
    "spring-boot": [
      "org.springframework.boot:spring-boot-starter-web",
      "org.springframework.boot:spring-boot-starter",
      "org.springframework.boot:spring-boot-starter-webflux",
    ],
    quarkus: ["io.quarkus:quarkus-core"],
    ktor: ["io.ktor:ktor-server-core"],
  }),
  ...group("backend_framework", "nuget", {
    "aspnet-core": ["Microsoft.AspNetCore.App", "Swashbuckle.AspNetCore"],
  }),
  ...group("state", "npm", {
    redux: ["redux", "@reduxjs/toolkit", "react-redux"],
    zustand: ["zustand"],
    jotai: ["jotai"],
    recoil: ["recoil"],
    mobx: ["mobx"],
    valtio: ["valtio"],
    pinia: ["pinia"],
    vuex: ["vuex"],
    xstate: ["xstate"],
    ngrx: ["@ngrx/store"],
  }),
  ...group("styling", "npm", {
    tailwind: ["tailwindcss"],
    "styled-components": ["styled-components"],
    emotion: ["@emotion/react", "@emotion/styled"],
    "vanilla-extract": ["@vanilla-extract/css"],
    sass: ["sass"],
    less: ["less"],
    unocss: ["unocss"],
    "panda-css": ["@pandacss/dev"],
    stitches: ["@stitches/react"],
  }),
  ...group("ui_kit", "npm", {
    mui: ["@mui/material"],
    chakra: ["@chakra-ui/react"],
    antd: ["antd"],
    mantine: ["@mantine/core"],
    radix: ["@radix-ui/themes", "radix-ui"],
    headlessui: ["@headlessui/react", "@headlessui/vue"],
    "element-plus": ["element-plus"],
    vuetify: ["vuetify"],
    daisyui: ["daisyui"],
    bootstrap: ["bootstrap", "react-bootstrap"],
  }),
  ...group("data_fetching", "npm", {
    "tanstack-query": [
      "@tanstack/react-query",
      "@tanstack/vue-query",
      "@tanstack/svelte-query",
      "react-query",
    ],
    swr: ["swr"],
    apollo: ["@apollo/client"],
    urql: ["urql"],
    "rtk-query": ["@reduxjs/toolkit"],
  }),
  ...group("router", "npm", {
    "react-router": ["react-router", "react-router-dom"],
    "tanstack-router": ["@tanstack/react-router"],
    "vue-router": ["vue-router"],
    wouter: ["wouter"],
  }),
  ...group("forms", "npm", {
    "react-hook-form": ["react-hook-form"],
    formik: ["formik"],
    "tanstack-form": ["@tanstack/react-form"],
    "vee-validate": ["vee-validate"],
  }),
  ...group("orm", "npm", {
    prisma: ["prisma", "@prisma/client"],
    drizzle: ["drizzle-orm"],
    typeorm: ["typeorm"],
    sequelize: ["sequelize"],
    mongoose: ["mongoose"],
    knex: ["knex"],
    kysely: ["kysely"],
    mikroorm: ["@mikro-orm/core"],
  }),
  ...group("orm", "pypi", {
    sqlalchemy: ["sqlalchemy"],
    "django-orm": ["django"],
    tortoise: ["tortoise-orm"],
    sqlmodel: ["sqlmodel"],
    peewee: ["peewee"],
  }),
  ...group("orm", "go", { gorm: ["gorm.io/gorm"], sqlx: ["github.com/jmoiron/sqlx"], ent: ["entgo.io/ent"] }),
  ...group("orm", "cargo", { diesel: ["diesel"], sqlx: ["sqlx"], seaorm: ["sea-orm"] }),
  ...group("orm", "rubygems", { activerecord: ["rails", "activerecord"] }),
  ...group("orm", "packagist", { eloquent: ["laravel/framework"], doctrine: ["doctrine/orm"] }),
  ...group("orm", "maven", { "spring-data-jpa": ["org.springframework.boot:spring-boot-starter-data-jpa"] }),
  ...group("orm", "nuget", { "ef-core": ["Microsoft.EntityFrameworkCore"] }),
  ...group("database", "npm", {
    postgres: ["pg", "postgres", "@neondatabase/serverless"],
    mysql: ["mysql2", "mysql"],
    sqlite: ["better-sqlite3", "sqlite3", "@libsql/client"],
    mongodb: ["mongodb", "mongoose"],
    supabase: ["@supabase/supabase-js"],
    firebase: ["firebase", "firebase-admin"],
  }),
  ...group("database", "pypi", {
    postgres: ["psycopg2", "psycopg2-binary", "psycopg", "asyncpg"],
    mysql: ["mysqlclient", "pymysql", "aiomysql"],
    mongodb: ["pymongo", "motor"],
  }),
  ...group("database", "go", {
    postgres: ["github.com/lib/pq", "github.com/jackc/pgx/v5"],
    mysql: ["github.com/go-sql-driver/mysql"],
    mongodb: ["go.mongodb.org/mongo-driver"],
  }),
  ...group("auth", "npm", {
    "next-auth": ["next-auth", "@auth/core"],
    "better-auth": ["better-auth"],
    clerk: ["@clerk/nextjs", "@clerk/clerk-react", "@clerk/express"],
    lucia: ["lucia"],
    passport: ["passport"],
    auth0: ["@auth0/nextjs-auth0", "@auth0/auth0-react"],
    "supabase-auth": ["@supabase/auth-helpers-nextjs", "@supabase/ssr"],
    jsonwebtoken: ["jsonwebtoken", "jose"],
  }),
  ...group("auth", "pypi", {
    "django-allauth": ["django-allauth"],
    authlib: ["authlib"],
    "fastapi-users": ["fastapi-users"],
    "flask-login": ["flask-login"],
    pyjwt: ["pyjwt"],
  }),
  ...group("auth", "rubygems", { devise: ["devise"] }),
  ...group("validation", "npm", {
    zod: ["zod"],
    yup: ["yup"],
    joi: ["joi"],
    valibot: ["valibot"],
    "class-validator": ["class-validator"],
    ajv: ["ajv"],
    arktype: ["arktype"],
  }),
  ...group("validation", "pypi", { pydantic: ["pydantic"], marshmallow: ["marshmallow"] }),
  ...group("test_runner", "npm", {
    vitest: ["vitest"],
    jest: ["jest"],
    mocha: ["mocha"],
    ava: ["ava"],
    "testing-library": ["@testing-library/react", "@testing-library/vue"],
  }),
  ...group("test_runner", "pypi", { pytest: ["pytest"] }),
  ...group("test_runner", "rubygems", { rspec: ["rspec-rails", "rspec"] }),
  ...group("test_runner", "packagist", { phpunit: ["phpunit/phpunit"], pest: ["pestphp/pest"] }),
  ...group("e2e", "npm", { playwright: ["@playwright/test", "playwright"], cypress: ["cypress"] }),
  ...group("queue", "npm", {
    bullmq: ["bullmq", "bull"],
    agenda: ["agenda"],
    kafka: ["kafkajs"],
    rabbitmq: ["amqplib"],
    inngest: ["inngest"],
    trigger: ["@trigger.dev/sdk"],
  }),
  ...group("queue", "pypi", { celery: ["celery"], rq: ["rq"], dramatiq: ["dramatiq"] }),
  ...group("queue", "rubygems", { sidekiq: ["sidekiq"] }),
  ...group("queue", "go", { asynq: ["github.com/hibiken/asynq"] }),
  ...group("cache", "npm", { redis: ["redis", "ioredis", "@upstash/redis"], memcached: ["memcached"] }),
  ...group("cache", "pypi", { redis: ["redis"] }),
  ...group("cache", "go", { redis: ["github.com/redis/go-redis/v9"] }),
  ...group("api_style", "npm", {
    trpc: ["@trpc/server"],
    graphql: ["graphql", "@apollo/server", "graphql-yoga"],
    grpc: ["@grpc/grpc-js"],
    openapi: ["@asteasolutions/zod-to-openapi", "openapi-typescript"],
  }),
  ...group("api_style", "pypi", {
    graphql: ["strawberry-graphql", "graphene"],
    "django-rest": ["djangorestframework"],
  }),
  ...group("build", "npm", {
    vite: ["vite"],
    webpack: ["webpack"],
    rollup: ["rollup"],
    esbuild: ["esbuild"],
    turbopack: ["turbo"],
    parcel: ["parcel"],
  }),
  ...group("logging", "npm", {
    pino: ["pino"],
    winston: ["winston"],
    sentry: ["@sentry/node", "@sentry/nextjs", "@sentry/react"],
  }),
  ...group("logging", "pypi", { structlog: ["structlog"], sentry: ["sentry-sdk"] }),
  ...group("payment", "npm", {
    stripe: ["stripe", "@stripe/stripe-js"],
    "lemon-squeezy": ["@lemonsqueezy/lemonsqueezy.js"],
    paddle: ["@paddle/paddle-node-sdk"],
  }),
  ...group("payment", "pypi", { stripe: ["stripe"] }),
  ...group("email", "npm", {
    nodemailer: ["nodemailer"],
    resend: ["resend"],
    sendgrid: ["@sendgrid/mail"],
    postmark: ["postmark"],
  }),
  ...group("storage", "npm", {
    s3: ["@aws-sdk/client-s3", "aws-sdk"],
    "vercel-blob": ["@vercel/blob"],
    uploadthing: ["uploadthing"],
  }),
  ...group("storage", "pypi", { s3: ["boto3"] }),
  ...group("realtime", "npm", {
    socketio: ["socket.io", "socket.io-client"],
    ws: ["ws"],
    pusher: ["pusher", "pusher-js"],
    ably: ["ably"],
  }),
  ...group("realtime", "pypi", { channels: ["channels"], websockets: ["websockets"] }),
  ...group("i18n", "npm", {
    i18next: ["i18next", "react-i18next"],
    "next-intl": ["next-intl"],
    "vue-i18n": ["vue-i18n"],
    "react-intl": ["react-intl"],
  }),
  ...group("date", "npm", {
    dayjs: ["dayjs"],
    "date-fns": ["date-fns"],
    moment: ["moment"],
    luxon: ["luxon"],
  }),
  ...group("http_client", "npm", { axios: ["axios"], ky: ["ky"], got: ["got"], ofetch: ["ofetch"] }),
  ...group("http_client", "pypi", { httpx: ["httpx"], requests: ["requests"], aiohttp: ["aiohttp"] }),
  ...group("dnd", "npm", {
    "dnd-kit": ["@dnd-kit/core"],
    "react-dnd": ["react-dnd"],
    "hello-pangea": ["@hello-pangea/dnd"],
    sortablejs: ["sortablejs"],
  }),
  ...group("animation", "npm", {
    motion: ["framer-motion", "motion"],
    gsap: ["gsap"],
    "react-spring": ["@react-spring/web"],
  }),
  ...group("icons", "npm", {
    lucide: ["lucide-react", "lucide-vue-next"],
    heroicons: ["@heroicons/react"],
    "react-icons": ["react-icons"],
    tabler: ["@tabler/icons-react"],
  }),
  ...group("ai", "npm", {
    "anthropic-sdk": ["@anthropic-ai/sdk"],
    "openai-sdk": ["openai"],
    "vercel-ai": ["ai"],
    langchain: ["langchain"],
  }),
  ...group("ai", "pypi", {
    "anthropic-sdk": ["anthropic"],
    "openai-sdk": ["openai"],
    langchain: ["langchain"],
  }),
];

/** Maps an ecosystem package name to the technologies it represents. */
export function technologiesFor(ecosystem: Ecosystem, name: string): Technology[] {
  return TECHNOLOGIES.filter((tech) => tech.ecosystem === ecosystem && tech.packages.includes(name));
}

/** Packages that imply a third-party service with credentials, used by the backend surface scan. */
export const EXTERNAL_SERVICES: Record<string, string> = {
  stripe: "Stripe",
  "@stripe/stripe-js": "Stripe",
  "@sendgrid/mail": "SendGrid",
  resend: "Resend",
  postmark: "Postmark",
  nodemailer: "SMTP",
  twilio: "Twilio",
  "aws-sdk": "AWS",
  "@aws-sdk/client-s3": "AWS S3",
  "@aws-sdk/client-ses": "AWS SES",
  "@aws-sdk/client-sqs": "AWS SQS",
  boto3: "AWS",
  openai: "OpenAI",
  "@anthropic-ai/sdk": "Anthropic",
  anthropic: "Anthropic",
  "firebase-admin": "Firebase",
  "@supabase/supabase-js": "Supabase",
  ioredis: "Redis",
  redis: "Redis",
  "@upstash/redis": "Upstash Redis",
  kafkajs: "Kafka",
  amqplib: "RabbitMQ",
  celery: "Celery broker",
  "@sentry/node": "Sentry",
  "sentry-sdk": "Sentry",
  algoliasearch: "Algolia",
  meilisearch: "Meilisearch",
  "@elastic/elasticsearch": "Elasticsearch",
  "@octokit/rest": "GitHub API",
  pusher: "Pusher",
  ably: "Ably",
  "@clerk/express": "Clerk",
  "@clerk/nextjs": "Clerk",
  "@auth0/nextjs-auth0": "Auth0",
};
