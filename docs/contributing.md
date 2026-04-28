# Convenciones del proyecto

## Flujo de trabajo
1. Cada cambio se hace en una branch nueva (NUNCA en main)
2. Cuando está listo, se abre un Pull Request a main
3. Otra persona revisa y aprueba
4. Se mergea con "Squash and merge"

## Nombres de branches
- `feat/nombre-corto` — feature nueva
- `fix/nombre-corto` — corrección de bug
- `docs/nombre-corto` — solo cambios de documentación
- `refactor/nombre-corto` — reorganización sin cambio de comportamiento

## Mensajes de commit (Conventional Commits)
- `feat: agregar contador de vida en tiempo real`
- `fix: corregir empate triple en tirada de dados`
- `docs: actualizar esquema de base de datos`

## Tamaño de PR
Un PR = un cambio cohesivo.

## Reviews
- Al menos 1 aprobación antes de mergear
- Los comentarios en review son pedidos de mejora, no críticas personales

## Secretos
NUNCA commitear archivos `.env`, claves de API, ni credenciales de Supabase.