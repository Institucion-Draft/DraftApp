# Modelo de datos

> Esquema SQL completo pendiente. Por definir antes de iniciar implementación.

## Decisiones tomadas

- Backend: Supabase (PostgreSQL)
- Colores de mazo: tabla normalizada `participant_colors` (1 fila por color por participación), no string concatenado.

## Por definir

- Esquema completo de tablas
- Estrategia de Row Level Security (RLS) en Supabase
- Estrategia de migraciones
- Estrategia de tipos TypeScript generados desde el esquema