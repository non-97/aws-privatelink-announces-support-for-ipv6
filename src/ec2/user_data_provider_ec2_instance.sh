# -x to display the command to be executed
set -x

# Redirect /var/log/user-data.log and /dev/console
exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

# Install the necessary packages
yum update -y
amazon-linux-extras list
amazon-linux-extras install nginx1 -y

# Start Nginx
systemctl start nginx
systemctl status nginx

# Enable Nginx
systemctl enable nginx
systemctl is-enabled nginx