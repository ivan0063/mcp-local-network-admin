# 🤖 Asistente Local — Jenkins + Home Assistant

Asistente de IA que controla tu infraestructura local mediante lenguaje natural.
Corre en tu red local y se conecta a Jenkins y Home Assistant vía sus APIs REST.

## Arquitectura

```
Tú (browser) → Express server → Claude API → herramientas locales
                                                  ├── Jenkins REST API
                                                  └── Home Assistant REST API
```

## Requisitos

- Node.js 18+
- Jenkins con API habilitada
- Home Assistant con acceso por token
- API key de Anthropic

## Instalación

```bash
# 1. Instalar dependencias
npm install

# 2. Copiar y configurar variables de entorno
cp .env.example .env
# → Edita .env con tus valores

# 3. Iniciar
npm start
# Accede en http://localhost:3000
```

## Cómo obtener los tokens

### Jenkins API Token
1. Entra a Jenkins → Tu usuario (arriba derecha) → Configurar
2. Baja hasta "API Token" → "Agregar nuevo token" → Genera y copia

### Home Assistant Token
1. Entra a HA → Tu perfil (abajo izquierda)
2. Baja hasta "Tokens de acceso de larga duración" → "Crear token"

## Ejemplos de uso

### Jenkins
- *"Muéstrame todos los jobs y su estado"*
- *"Haz deploy de mi-app copiando el pipeline de otra-app"*
- *"¿Cuál fue el resultado del último build de frontend?"*
- *"Dispara el build de backend con el parámetro BRANCH=feature/login"*
- *"Muéstrame el log del último build fallido de api-service"*

### Home Assistant
- *"¿Qué luces están encendidas?"*
- *"Apaga todas las luces de la sala"*
- *"Ponle la temperatura al AC a 22 grados"*
- *"Lista todas mis automatizaciones"*
- *"Activa la escena de cine"*
- *"¿Cuánto consume el sensor de energía ahora?"*
- *"¿Qué se rompe si borro el sensor de la cocina?"* (búsqueda de relaciones)
- *"¿Por qué no se disparó la automatización de las luces anoche?"* (trazas de ejecución)
- *"Agrega leche a la lista de compras"* / *"¿Qué hay pendiente en mi lista de tareas?"*
- *"¿Hay algún problema o aviso pendiente en Home Assistant?"* (Repairs)
- *"Corrige el consumo del medidor de energía, se reinició ayer"*
- *"Busca música de rock en mi media source"*
- *"Configura una integración nueva de MQTT"*

## Agregar más integraciones

Para agregar algo como Philips Hue, router ASUS, etc.:

1. Crea `src/tools/nuevo-servicio.js` con la clase cliente
2. Define las herramientas en el array `TOOLS` de `src/agent.js`
3. Agrega los casos en la función `executeTool`
4. Agrega las variables de entorno en `.env`

## Seguridad

⚠️ Este servidor no tiene autenticación — corre **solo en tu red local**.
No lo expongas a internet sin agregar auth primero.
