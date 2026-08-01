# 斯源直播样品管理系统

面向直播带货公司的内部样品管理系统。它把“商品款式”和“实物样品”分开管理：同一货号可以有多件实物，每件实物都有独立编号、二维码、当前位置和完整流转记录。

## 已实现功能

- 商品到样登记：货号、商品名称、多个选品直播间、商务对接人、店铺与合作信息、分类、标签和多个外部图片网址。
- 逐件实物管理：按到样数量自动创建独立编号，每件样品分别记录到样日期。
- 位置全程追踪：商务部具体位置、各直播间以及已退样、已消耗、已损坏、已丢失、已赠送、已报废。
- 单件与批量流转：有权限的账号可直接修改位置或状态，备注选填，每件样品都会留下独立操作记录。
- 手机扫码：调用手机摄像头识别二维码，也支持手动输入独立编号。
- 权限管理：管理员自由创建平级部门、角色、权限和账号；每个账号只有一个所属部门与一个角色，可设置查看全公司或本部门相关数据。
- 搜索与统计：首页统计、商品与实物筛选、位置分布、完整流转和操作日志。
- Excel 导出：商品档案、实物样品和流转记录。
- 数据备份：每天北京时间凌晨 03:00 自动备份，滚动保留最近 30 天；管理员也可手动备份、下载或删除。
- 电脑与手机响应式界面，所有页面登录后才能访问。

> 商品图片仅保存外部网址，不上传图片文件，不占用服务器图片存储空间。

## 服务器要求

- Ubuntu 22.04 或 Ubuntu 24.04
- 建议至少 2 核 CPU、2 GB 内存、20 GB 磁盘
- 一个已经解析到服务器公网 IP 的域名
- 服务器开放 80 和 443 端口

## 一键安装

在已经解析好域名的 Ubuntu 服务器上执行：

```bash
curl -fsSL https://raw.githubusercontent.com/fangtang1214/siyuan/main/install.sh | sudo bash
```

安装过程会询问：

1. 系统域名；
2. 初始管理员账号；
3. 管理员姓名；
4. 管理员密码。

安装脚本会自动准备运行环境、数据库、HTTPS 证书和每日备份。完成后直接访问 `https://你的域名`。

## 更新系统

登录服务器后运行：

```bash
sudo bash /opt/siyuan/update.sh
```

更新不会删除已有数据库、样品记录和备份。

## 首次使用建议

1. 使用安装时创建的管理员账号登录；
2. 在“部门管理”中创建各直播间；
3. 在“位置管理”中创建商务部的仓库、货架或存放区域；
4. 在“角色权限”中创建商务部、直播间等角色并勾选权限；
5. 在“账号管理”中创建员工账号；
6. 开始登记商品和到样数量。

## 数据备份与恢复

系统每天生成 PostgreSQL 压缩备份，保存在独立数据卷中。管理员可以在“数据备份”页面下载备份文件到本地长期保存。

恢复数据库属于高风险操作。需要恢复时，请先停止录入，并由服务器维护人员按以下方式处理：

```bash
cd /opt/siyuan
docker compose stop app backup
docker compose exec -T database dropdb -U siyuan --if-exists siyuan
docker compose exec -T database createdb -U siyuan siyuan
docker compose exec -T database pg_restore -U siyuan -d siyuan --clean --if-exists < 你的备份.dump
docker compose start app backup
```

## 本地开发

本项目使用 Next.js、PostgreSQL 和 Docker。开发环境需要 Node.js 22 及 PostgreSQL 15 或更高版本。

```bash
npm install
cp .env.example .env
npm run db:bootstrap
npm run dev
```

默认访问地址为 `http://localhost:3000`。
