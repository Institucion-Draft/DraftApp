# DraftGalicia — Arquitectura del proyecto

## Qué es

Aplicación móvil de gestión y registro histórico para sesiones de Draft de Magic: The Gathering jugadas con proxies. Combina seguimiento en tiempo real de partidas con estadísticas históricas persistentes, organizado en torno a grupos (workspaces) y eventos discretos (drafts).

## Arquitectura conceptual

PLATAFORMA
└── WORKSPACES (grupos, ej: "DraftGalicia")
    └── DRAFT EVENTS (sesiones de draft)
        └── PAIRINGS (enfrentamientos)
            └── MATCHES (partidas) + LIFE EVENTS (serie de tiempo de vida)

## Stack técnico

- Frontend: React Native via Expo
- Lenguaje: TypeScript
- Backend / DB: Supabase (PostgreSQL + Auth + Realtime)
- Hosting: tier Free de Supabase
- Repositorio: monorepo con app móvil + migraciones SQL + docs

## Entidades principales

| Entidad técnica | Descripción |
|---|---|
| User | Perfil global del jugador |
| Workspace | Grupo contenedor de eventos |
| Draft Event | Sesión de draft: cubo, sede, fecha, duración, participantes |
| Participant | Usuario en un evento específico, con sus colores ese día |
| Ghost | Usuario en modo solo-lectura dentro de un evento |
| Exile User | Participante invitado temporal sin cuenta permanente |
| Pairing | Enfrentamiento entre dos jugadores (o dos parejas en 2HG) |
| Match | Partida individual dentro de un Pairing |
| Life Event | Cada delta de vida con timestamp |
| Two-Headed Giant Game | Pairing 2v2 con vida compartida |
| Revenge Series | Serie post-draft al mejor de 5 |
| Super Cup | Serie paralela: gana quien hace 2 victorias seguidas |
| Die Roll | Tiro de d20 que define los pairings iniciales |

## Modos de puntuación

- Clásico: rankea por enfrentamientos ganados (BO3 prioritario, fallback a BO1)
- Diferencial: +2 por partido ganado, -1 por partido perdido

## Métricas primitivas registradas por partida

- Timestamp de inicio y fin
- Serie de tiempo completa de vida por jugador
- Resultado (ganador)
- Contexto: Draft / Revenge / Super Cup / Extra-draft / 2HG
- Jugadores y sus colores en ese evento
- Evento y workspace al que pertenece

Toda métrica derivada se calcula con queries sobre estos primitivos.