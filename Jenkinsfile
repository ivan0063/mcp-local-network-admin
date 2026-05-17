pipeline {
  agent any

  // ─── Ajusta estas variables a tu entorno ──────────────────────
  environment {
    IMAGE_NAME    = 'mcp-local-network-admin'
    // Si usas un registry local, ej: '192.168.1.50:5000/mcp-local-network-admin'
    // Si usas Docker Hub: 'tuusuario/mcp-local-network-admin'
    IMAGE_FULL    = "${REGISTRY}/${IMAGE_NAME}"
    CONTAINER     = 'mcp-local-network-admin'
    DEPLOY_PORT   = '3000'
  }

  parameters {
    // Registry donde se publica la imagen (sin trailing slash)
    string(name: 'REGISTRY',     defaultValue: 'localhost:5000',   description: 'Docker registry')
    // Host donde se despliega (puede ser localhost si Jenkins corre en el mismo servidor)
    string(name: 'DEPLOY_HOST',  defaultValue: 'localhost',        description: 'Host de despliegue')
    // Credencial SSH configurada en Jenkins para conectarse al host de despliegue
    string(name: 'SSH_CRED_ID',  defaultValue: 'deploy-ssh-key',  description: 'ID de credencial SSH en Jenkins')
    // Credencial del tipo "Secret file" que contiene el .env de producción
    string(name: 'ENV_CRED_ID',  defaultValue: 'mcp-env-file',    description: 'ID del Secret file con el .env')
  }

  stages {

    stage('Checkout') {
      steps {
        checkout scm
        script {
          env.GIT_SHA   = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
          env.IMAGE_TAG = "${IMAGE_FULL}:${GIT_SHA}"
          env.IMAGE_LATEST = "${IMAGE_FULL}:latest"
          echo "Imagen: ${IMAGE_TAG}"
        }
      }
    }

    stage('Build') {
      steps {
        sh "docker build -t ${IMAGE_TAG} -t ${IMAGE_LATEST} ."
      }
    }

    stage('Smoke test') {
      steps {
        script {
          // Arranca el contenedor sin .env real solo para verificar que responde
          sh "docker run -d --name mcp-smoke-${BUILD_NUMBER} -p 3999:3000 ${IMAGE_TAG}"
          sleep(5)
          sh "curl -sf http://localhost:3999/ | grep -q 'mcp-local-network-admin'"
        }
      }
      post {
        always {
          sh "docker rm -f mcp-smoke-${BUILD_NUMBER} || true"
        }
      }
    }

    stage('Push') {
      steps {
        sh "docker push ${IMAGE_TAG}"
        sh "docker push ${IMAGE_LATEST}"
      }
    }

    stage('Deploy') {
      steps {
        withCredentials([
          sshUserPrivateKey(credentialsId: params.SSH_CRED_ID, keyFileVariable: 'SSH_KEY', usernameVariable: 'SSH_USER'),
          file(credentialsId: params.ENV_CRED_ID, variable: 'ENV_FILE'),
        ]) {
          script {
            def host = params.DEPLOY_HOST
            def ssh  = "ssh -i \$SSH_KEY -o StrictHostKeyChecking=no \$SSH_USER@${host}"

            // Copia el .env al servidor
            sh "scp -i \$SSH_KEY -o StrictHostKeyChecking=no \$ENV_FILE \$SSH_USER@${host}:/opt/${CONTAINER}/.env"

            // Pull y restart del contenedor
            sh """
              ${ssh} '
                docker pull ${IMAGE_TAG} &&
                docker rm -f ${CONTAINER} 2>/dev/null || true &&
                docker run -d \\
                  --name ${CONTAINER} \\
                  --restart unless-stopped \\
                  -p ${DEPLOY_PORT}:3000 \\
                  --env-file /opt/${CONTAINER}/.env \\
                  ${IMAGE_TAG}
              '
            """
          }
        }
      }
    }

  }

  post {
    success {
      echo "✅ Desplegado: ${IMAGE_TAG} en ${params.DEPLOY_HOST}:${DEPLOY_PORT}"
    }
    failure {
      echo "❌ Pipeline fallido en stage: ${currentBuild.result}"
    }
    cleanup {
      // Limpia imágenes viejas localmente (mantiene las últimas 3)
      sh "docker images ${IMAGE_FULL} --format '{{.ID}}' | tail -n +4 | xargs -r docker rmi || true"
    }
  }
}
